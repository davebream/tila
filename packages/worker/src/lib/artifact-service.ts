/**
 * artifact-service.ts
 *
 * Business logic extracted from routes/artifacts.ts. Functions accept injected
 * R2/DO deps so they are unit-testable in isolation with fakes.
 *
 * This is a mechanical move — no new orchestration, no logic rewrite.
 * R2-compensation and pointer-retry ordering are preserved exactly.
 */

import {
  GREP_MAX_MATCHES,
  GREP_MAX_MATCHES_PER_BLOB,
  GREP_PER_BLOB_BYTE_CAP,
  GREP_TOTAL_BYTE_CAP,
  matchLine,
  splitChunkIntoLines,
} from "@tila/core";
import { forwardToDO } from "./do-forward";

// ---------------------------------------------------------------------------
// Types re-exported from the route module so callers / tests can use them
// ---------------------------------------------------------------------------

export type PointerResult =
  | { ok: true; response: Response }
  | { ok: false; response: Response | null; threw: boolean };

export type CompensationResult = {
  status: 500 | 502;
  body: {
    ok: false;
    error: {
      code: "upload-failed" | "pointer-registration-failed";
      message: string;
      retryable: true;
      r2Key?: string;
    };
  };
};

export interface GrepCandidate {
  r2_key: string;
  kind: string;
  resource: string | null;
  mime_type: string;
  bytes: number;
  content_inline: string | null;
}

export type GrepResult = {
  key: string;
  kind: string;
  resource: string | null;
  lines: Array<{ line: number; text: string; col: number }>;
  truncated?: boolean;
};

/** Shared mutable state for a single grep scan pass. */
export interface GrepScanState {
  totalBytes: number;
  totalMatches: number;
  truncated: boolean;
  scanned: number;
  skipped: number;
}

// ---------------------------------------------------------------------------
// Retry + compensation helpers for the artifact upload route
// ---------------------------------------------------------------------------

/**
 * Calls DO /artifact/pointer with a single retry on transient failure.
 *
 * Retry fires when:
 *   (a) stub.fetch() throws (network error), or
 *   (b) the response status is 5xx (DO internal error).
 *
 * 4xx responses are NOT retried — deterministic failures (undeclared kind,
 * stale fence, validation) cannot be resolved by retry.
 *
 * upsertPointer uses INSERT OR IGNORE, so retries are idempotent.
 */
export async function callPointerWithRetry(
  stub: DurableObjectStub,
  payload: Record<string, unknown>,
  analyticsCtx:
    | {
        analytics: AnalyticsEngineDataset;
        ctx: ExecutionContext;
        projectId: string;
      }
    | undefined,
): Promise<PointerResult> {
  const MAX_ATTEMPTS = 2;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let response: Response;
    try {
      response = await forwardToDO(
        stub,
        "/artifact/pointer",
        "POST",
        payload,
        undefined,
        analyticsCtx,
      );
    } catch {
      // Network error (stub.fetch threw) -- retry if attempts remain
      if (attempt < MAX_ATTEMPTS - 1) continue;
      return { ok: false, response: null, threw: true };
    }

    // 2xx -- success
    if (response.ok) {
      return { ok: true, response };
    }

    // 4xx -- deterministic failure, do NOT retry
    if (response.status >= 400 && response.status < 500) {
      return { ok: false, response, threw: false };
    }

    // 5xx -- transient failure, retry if attempts remain
    if (attempt < MAX_ATTEMPTS - 1) continue;
    return { ok: false, response, threw: false };
  }

  // Should not reach here, but TypeScript needs exhaustive return
  return { ok: false, response: null, threw: true };
}

/**
 * Attempts R2 delete compensation after all pointer registration attempts fail.
 *
 * Two outcomes:
 *   - R2 delete succeeds: returns 502 upload-failed (no r2Key -- blob cleaned up).
 *   - R2 delete fails: returns 500 pointer-registration-failed with r2Key in body
 *     (blob exists in R2 pending reconciliation; r2Key is the recovery key).
 */
export async function compensateAndRespond(
  r2: { delete(key: string): Promise<void> },
  r2Key: string,
): Promise<CompensationResult> {
  try {
    await r2.delete(r2Key);
    // Compensation succeeded: blob removed, no pointer row, clean state
    return {
      status: 502,
      body: {
        ok: false,
        error: {
          code: "upload-failed",
          message:
            "Artifact upload failed: DO pointer registration failed after retry. Blob cleaned up. Retry the full upload.",
          retryable: true,
        },
      },
    };
  } catch {
    // Compensation also failed: blob exists in R2, no pointer row
    // Include r2Key so client/SDK can use it for recovery
    return {
      status: 500,
      body: {
        ok: false,
        error: {
          code: "pointer-registration-failed",
          message:
            "Artifact upload partially failed: blob stored in R2 but pointer registration failed. Blob pending reconciliation.",
          retryable: true,
          r2Key,
        },
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Grep scan helpers
// ---------------------------------------------------------------------------

/**
 * Shared line-scan accumulator — used by BOTH the inline path and the R2
 * path so cap/match-accounting logic lives in one place.
 *
 * Feed decoded string chunks via `pushChunk(decoded)`. When the blob is
 * fully consumed, call `flush()` to process the final pending line.
 *
 * Callers are responsible for tracking raw byte counts and setting
 * `blobTruncated` / `truncated` flags before calling `pushChunk` so the
 * accumulator can stop early.
 */
export function makeLineScanAccumulator(
  matcher: (
    line: string,
    lineNumber: number,
  ) => { line: number; text: string; col: number } | null,
  state: GrepScanState,
) {
  const blobLines: Array<{ line: number; text: string; col: number }> = [];
  let blobMatches = 0;
  let blobTruncated = false;
  let pending = "";
  let lineNumber = 0;

  function processLines(lines: string[]): void {
    for (const line of lines) {
      lineNumber++;
      if (blobMatches >= GREP_MAX_MATCHES_PER_BLOB) {
        blobTruncated = true;
        break;
      }
      if (state.totalMatches >= GREP_MAX_MATCHES) {
        state.truncated = true;
        break;
      }
      const hit = matcher(line, lineNumber);
      if (hit) {
        blobLines.push(hit);
        blobMatches++;
        state.totalMatches++;
      }
    }
  }

  return {
    /** Feed a decoded string chunk. Returns true if scanning should stop. */
    pushChunk(decoded: string): boolean {
      if (blobTruncated || state.truncated) return true;
      const { lines, pending: newPending } = splitChunkIntoLines(
        pending,
        decoded,
      );
      pending = newPending;
      processLines(lines);
      return blobTruncated || state.truncated;
    },

    /** Flush the final pending line at EOF. */
    flush(): void {
      if (blobTruncated || state.truncated) return;
      if (pending) {
        lineNumber++;
        if (
          blobMatches < GREP_MAX_MATCHES_PER_BLOB &&
          state.totalMatches < GREP_MAX_MATCHES
        ) {
          const hit = matcher(pending, lineNumber);
          if (hit) {
            blobLines.push(hit);
            blobMatches++;
            state.totalMatches++;
          }
        }
      }
    },

    get lines() {
      return blobLines;
    },
    get isBlobTruncated() {
      return blobTruncated;
    },
    setBlobTruncated() {
      blobTruncated = true;
    },
  };
}

/**
 * Scans a single R2-backed candidate for grep matches.
 *
 * @param r2Bucket - the R2 bucket (injectable for testing)
 * @param candidate - the artifact candidate
 * @param matcher - compiled grep matcher function
 * @param state - shared mutable scan state (totalBytes, totalMatches, truncated, scanned, skipped)
 * @param deadline - optional AbortSignal for time-bounding the scan
 * @returns a GrepResult if matches found, or null
 */
export async function scanR2Candidate(
  r2Bucket: { get(key: string): Promise<{ body: ReadableStream } | null> },
  candidate: GrepCandidate,
  matcher: (
    line: string,
    lineNumber: number,
  ) => { line: number; text: string; col: number } | null,
  state: GrepScanState,
  deadline?: AbortSignal,
): Promise<GrepResult | null> {
  try {
    const obj = await r2Bucket.get(candidate.r2_key);
    if (obj == null) {
      state.skipped++;
      return null;
    }

    // Read raw Uint8Array chunks from the R2 body to track RAW bytes pulled
    // from R2 (per design spec: GREP_PER_BLOB_BYTE_CAP / GREP_TOTAL_BYTE_CAP
    // are measured on raw bytes, tracking value.byteLength before decode).
    // A stateful TextDecoder handles multi-byte code points across chunk
    // boundaries without re-encoding.
    const rawReader = obj.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: false });

    const acc = makeLineScanAccumulator(matcher, state);
    let blobBytes = 0;

    try {
      while (true) {
        const { done, value } = await rawReader.read();

        if (done) {
          // Flush the decoder's internal state for the final incomplete
          // multi-byte sequence (if any), then push through the accumulator.
          const tail = decoder.decode(undefined, { stream: false });
          if (tail) acc.pushChunk(tail);
          break;
        }

        // Count RAW bytes before decode — this is the normative byte cap.
        blobBytes += value.byteLength;
        state.totalBytes += value.byteLength;

        // Decode this chunk with streaming to preserve multi-byte boundaries.
        // Always decode and scan lines from the current chunk before checking
        // caps — this ensures matches from already-read content are not
        // silently dropped even when the chunk pushes us over the byte cap.
        const decoded = decoder.decode(value, { stream: true });
        acc.pushChunk(decoded);

        // After processing the chunk's lines, set truncation flags so the
        // NEXT iteration (or the break below) stops further scanning.
        if (blobBytes > GREP_PER_BLOB_BYTE_CAP) {
          acc.setBlobTruncated();
        }
        if (state.totalBytes >= GREP_TOTAL_BYTE_CAP || deadline?.aborted) {
          state.truncated = true;
        }

        if (acc.isBlobTruncated || state.truncated) break;
      }
    } finally {
      rawReader.cancel().catch(() => {});
    }

    // Flush the final pending line at EOF (accumulator handles the guard).
    acc.flush();

    state.scanned++;

    if (acc.lines.length > 0) {
      const result: GrepResult = {
        key: candidate.r2_key,
        kind: candidate.kind,
        resource: candidate.resource,
        lines: acc.lines,
      };
      if (acc.isBlobTruncated) result.truncated = true;
      return result;
    }
    return null;
  } catch {
    // R2 get throws OR body stream throws — skip this candidate
    state.skipped++;
    return null;
  }
}
