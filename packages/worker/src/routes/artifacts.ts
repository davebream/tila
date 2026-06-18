import { R2ArtifactBackend } from "@tila/backend-r2";
import {
  GREP_DEADLINE_MS,
  GREP_MAX_MATCHES,
  GREP_MAX_MATCHES_PER_BLOB,
  GREP_PER_BLOB_BYTE_CAP,
  GREP_TOTAL_BYTE_CAP,
  GrepQueryError,
  compileGrepMatcher,
  matchLine,
  splitChunkIntoLines,
  validateGrepPattern,
} from "@tila/core";
import {
  ArtifactGrepQuerySchema,
  ArtifactSearchQuerySchema,
  ArtifactTextWriteRequestSchema,
  TilaSchemaTomlSchema,
  parseTagFilter,
} from "@tila/schemas";
import { Hono } from "hono";
import TOML from "smol-toml";
import { ZodError, z } from "zod";
import { ARTIFACT_REPAIR_SCAN_LIMIT } from "../config";
import { analyticsCtxFrom } from "../lib/analytics";
import { DO_PATHS, forwardTypedDO } from "../lib/do-contract";
import { forwardToDO } from "../lib/do-forward";
import {
  MAX_BYTES_FOR_NORMALIZATION,
  normalizeArtifactText,
} from "../lib/normalize-text";
import { type ScanRow, buildRebuildCandidates } from "../lib/search-rebuild";
import { zodValidationError } from "../lib/validation";
import { requirePermission } from "../middleware/permission";
import type { Env, HonoVariables } from "../types";

const INLINE_THRESHOLD = 64 * 1024;
const ARTIFACT_METADATA_MAX_BYTES = 8_192;
const RECONCILE_ENRICH_BATCH_SIZE = 50;
const ARTIFACT_TEXT_CONTENT_MAX_CHARS = 1_000_000;

const ArtifactRelationshipRequestSchema = z.object({
  from_key: z.string().min(1),
  to_key: z.string().min(1),
  type: z.string().min(1),
  metadata: z.record(z.unknown()).optional(),
});

export const artifacts = new Hono<{
  Bindings: Env;
  Variables: HonoVariables;
}>();

function jsonByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function sanitizeArtifactExtension(ext: string | null | undefined): string {
  const cleaned = (ext ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 10);
  return cleaned || "bin";
}

/**
 * A produced-artifact R2 key is `produced/<resource>/<sha256>.<ext>`. R2 keys
 * are opaque strings — R2 does not normalize `/` or `..` — so a `resource`
 * containing a slash or `..` could break out of its key prefix
 * (e.g. `produced/../../sources/...`). Entity resources are `<type>:<id>` with
 * no slash, so reject those characters at the Worker boundary, mirroring the
 * entity-id DB constraint.
 */
export function isUnsafeArtifactResource(resource: string): boolean {
  return resource.includes("/") || resource.includes("..");
}

// ---------------------------------------------------------------------------
// Retry + compensation helpers for the artifact upload route
// ---------------------------------------------------------------------------

type PointerResult =
  | { ok: true; response: Response }
  | { ok: false; response: Response | null; threw: boolean };

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

type CompensationResult = {
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

// POST /projects/:projectId/artifacts/text -- text-first artifact write (JSON body)
artifacts.post("/text", requirePermission("write"), async (c) => {
  const raw = await c.req.json();
  if (
    typeof raw === "object" &&
    raw !== null &&
    typeof (raw as { content?: unknown }).content === "string" &&
    (raw as { content: string }).content.length >
      ARTIFACT_TEXT_CONTENT_MAX_CHARS
  ) {
    return c.json(
      {
        ok: false,
        error: {
          code: "validation-error",
          message: "content is too large",
          retryable: false,
        },
      },
      400,
    );
  }
  const parsed = ArtifactTextWriteRequestSchema.safeParse(raw);
  if (!parsed.success) return zodValidationError(c, parsed.error);

  const {
    content,
    kind,
    mime_type: mimeType,
    resource,
    fence,
    tags,
  } = parsed.data;

  if (resource && fence === undefined) {
    return c.json(
      {
        ok: false,
        error: {
          code: "missing-fence",
          message: "fence is required when uploading a produced artifact",
          retryable: false,
        },
      },
      400,
    );
  }

  if (resource && isUnsafeArtifactResource(resource)) {
    return c.json(
      {
        ok: false,
        error: {
          code: "validation-error",
          message: "resource must not contain '/' or '..'",
          retryable: false,
        },
      },
      400,
    );
  }

  const encoder = new TextEncoder();
  const fileBytes = encoder.encode(content);

  const hashBuffer = await crypto.subtle.digest("SHA-256", fileBytes);
  const sha256 = Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  const normalizedText = normalizeArtifactText(fileBytes.buffer, mimeType);

  const ext =
    mimeType === "text/markdown"
      ? "md"
      : mimeType === "text/plain"
        ? "txt"
        : sanitizeArtifactExtension(mimeType.split("/").pop());

  let r2Key: string;
  if (resource) {
    r2Key = `produced/${resource}/${sha256}.${ext}`;
  } else {
    r2Key = `sources/${sha256}.${ext}`;
  }

  const r2 = new R2ArtifactBackend(c.env.ARTIFACTS);
  const tokenResult = c.get("tokenResult");
  const r2Result = await r2.put({
    key: r2Key,
    body: fileBytes.buffer,
    sha256,
    contentType: mimeType,
    metadata: {
      "tila-task": resource ?? "",
      "tila-fence": fence !== undefined ? String(fence) : "",
      "tila-machine": tokenResult.name,
      "tila-kind": kind,
      "tila-sha256": sha256,
      "tila-mime": mimeType,
    },
  });

  const isInlineable =
    mimeType.startsWith("text/") && fileBytes.byteLength <= INLINE_THRESHOLD;
  const contentInline = isInlineable ? content : null;

  const stub = c.get("doStub");
  const now = Date.now();
  const pointerPayload = {
    r2_key: r2Key,
    resource: resource ?? null,
    kind,
    sha256,
    bytes: fileBytes.byteLength,
    fence: fence ?? null,
    mime_type: mimeType,
    produced_at: now,
    produced_by: tokenResult.name,
    expires_at: null,
    actor: tokenResult.name,
    search_title: normalizedText?.title ?? null,
    search_body_text: normalizedText?.body_text ?? null,
    actor_token_id: tokenResult.tokenId,
    content_inline: contentInline,
    source: c.get("source"),
    source_version: c.get("sourceVersion"),
    tags: tags ?? undefined,
  };

  const pointerResult = await callPointerWithRetry(
    stub,
    pointerPayload,
    analyticsCtxFrom(c),
  );

  if (
    !pointerResult.ok &&
    pointerResult.response !== null &&
    pointerResult.response.status >= 400 &&
    pointerResult.response.status < 500
  ) {
    const doBody = await pointerResult.response.json();
    return c.json(doBody, pointerResult.response.status as 400);
  }

  if (!pointerResult.ok) {
    const compensation = await compensateAndRespond(r2, r2Key);
    return c.json(compensation.body, compensation.status);
  }

  const deduplicated = r2Result.bytes === 0;
  return c.json({
    ok: true,
    key: r2Key,
    bytes: fileBytes.byteLength,
    deduplicated,
  });
});

// POST /projects/:projectId/artifacts -- upload file to R2 + DO pointer
artifacts.post("/", requirePermission("write"), async (c) => {
  const formData = await c.req.formData();

  const file = formData.get("file");
  if (!(file instanceof File)) {
    return c.json(
      {
        ok: false,
        error: {
          code: "validation-error",
          message: "file field is required (multipart)",
          retryable: false,
        },
      },
      400,
    );
  }

  const kind = formData.get("kind") as string | null;
  if (!kind) {
    return c.json(
      {
        ok: false,
        error: {
          code: "validation-error",
          message: "kind field is required",
          retryable: false,
        },
      },
      400,
    );
  }

  const resource = formData.get("resource") as string | null;
  if (resource && isUnsafeArtifactResource(resource)) {
    return c.json(
      {
        ok: false,
        error: {
          code: "validation-error",
          message: "resource must not contain '/' or '..'",
          retryable: false,
        },
      },
      400,
    );
  }
  const fenceStr = formData.get("fence") as string | null;
  const fence = fenceStr ? Number.parseInt(fenceStr, 10) : null;
  // Extract tags from FormData -- sent as a JSON-encoded array string
  const tagsRaw = formData.get("tags") as string | null;
  let tags: string[] | undefined;
  if (tagsRaw) {
    try {
      const parsed = JSON.parse(tagsRaw);
      if (Array.isArray(parsed)) tags = parsed as string[];
    } catch {
      // invalid JSON -- ignore and leave tags undefined
    }
  }
  if (resource && fence === null) {
    return c.json(
      {
        ok: false,
        error: {
          code: "missing-fence",
          message: "fence is required when uploading a produced artifact",
          retryable: false,
        },
      },
      400,
    );
  }
  const mimeType =
    (formData.get("mime_type") as string | null) ??
    file.type ??
    "application/octet-stream";

  // Compute SHA-256 of file content
  const fileBytes = await file.arrayBuffer();
  const hashBuffer = await crypto.subtle.digest("SHA-256", fileBytes);
  const sha256 = Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  // Normalize text for search indexing (T5).
  // Returns null for non-text MIME types or oversized artifacts -- zero cost.
  const normalizedText = normalizeArtifactText(fileBytes, mimeType);

  // Derive extension from filename or mime_type
  const ext = sanitizeArtifactExtension(
    file.name?.split(".").pop() ?? mimeType.split("/").pop(),
  );
  // Key derivation:
  //   flavor=index  -> indexes/<sha256>.<ext>  (lifecycle-exempt: expires_at stays null)
  //   resource set  -> produced/<resource>/<sha256>.<ext>
  //   no resource   -> sources/<sha256>.<ext>
  const flavor = formData.get("flavor") as string | null;
  let r2Key: string;
  const expiresAt: number | null = null;
  if (flavor === "index") {
    r2Key = `indexes/${sha256}.${ext}`;
    // Index artifacts are lifecycle-exempt: expiresAt stays null
  } else if (resource) {
    r2Key = `produced/${resource}/${sha256}.${ext}`;
  } else {
    r2Key = `sources/${sha256}.${ext}`;
  }

  // Upload to R2 with full tila-* metadata
  const r2 = new R2ArtifactBackend(c.env.ARTIFACTS);
  const tokenResult = c.get("tokenResult");
  const r2Result = await r2.put({
    key: r2Key,
    body: fileBytes,
    sha256,
    contentType: mimeType,
    metadata: {
      "tila-task": resource ?? "",
      "tila-fence": fence !== null ? String(fence) : "",
      "tila-machine": tokenResult.name,
      "tila-kind": kind,
      "tila-sha256": sha256,
      "tila-mime": mimeType,
    },
  });

  const isInlineable =
    mimeType.startsWith("text/") && fileBytes.byteLength <= INLINE_THRESHOLD;
  const contentInline = isInlineable
    ? new TextDecoder().decode(fileBytes)
    : null;

  // Register pointer in DO (with retry on transient failure)
  const stub = c.get("doStub");
  const now = Date.now();
  const pointerPayload = {
    r2_key: r2Key,
    resource: resource ?? null,
    kind,
    sha256,
    bytes: fileBytes.byteLength,
    fence,
    mime_type: mimeType,
    produced_at: now,
    produced_by: tokenResult.name,
    expires_at: expiresAt,
    actor: tokenResult.name,
    search_title: normalizedText?.title ?? null,
    search_body_text: normalizedText?.body_text ?? null,
    actor_token_id: tokenResult.tokenId,
    content_inline: contentInline,
    source: c.get("source"),
    source_version: c.get("sourceVersion"),
    tags,
  };

  const pointerResult = await callPointerWithRetry(
    stub,
    pointerPayload,
    analyticsCtxFrom(c),
  );

  // 4xx -- deterministic DO failure (undeclared kind, fence mismatch, validation)
  // Forward the DO's error response to the client verbatim
  if (
    !pointerResult.ok &&
    pointerResult.response !== null &&
    pointerResult.response.status >= 400 &&
    pointerResult.response.status < 500
  ) {
    const doBody = await pointerResult.response.json();
    return c.json(doBody, pointerResult.response.status as 400);
  }

  // Transient failure -- all attempts exhausted (threw or 5xx)
  if (!pointerResult.ok) {
    const compensation = await compensateAndRespond(r2, r2Key);
    return c.json(compensation.body, compensation.status);
  }

  // Success -- pointer registered (first try or retry)
  const deduplicated = r2Result.bytes === 0;
  return c.json({
    ok: true,
    key: r2Key,
    bytes: fileBytes.byteLength,
    deduplicated,
  });
});

// GET /projects/:projectId/artifacts -- list artifact pointers from DO
artifacts.get("/", requirePermission("read"), async (c) => {
  const stub = c.get("doStub");
  const query: Record<string, string> = {};
  const resource = c.req.query("resource");
  if (resource) query.resource = resource;
  const kind = c.req.query("kind");
  if (kind) query.kind = kind;
  const limit = c.req.query("limit");
  if (limit) query.limit = limit;
  let tagFilter: string[] | undefined;
  try {
    tagFilter = parseTagFilter(c.req.query("tag_filter"));
  } catch (err) {
    if (err instanceof ZodError) return zodValidationError(c, err);
    throw err;
  }
  if (tagFilter?.length) query.tag_filter = tagFilter.join(",");
  return forwardToDO(
    stub,
    "/artifact/list",
    "GET",
    undefined,
    query,
    analyticsCtxFrom(c),
  );
});

// GET /projects/:projectId/artifacts/latest -- get latest version for (kind, resource)
// Note: must be registered BEFORE the /:key{.+$} catch-all
artifacts.get("/latest", requirePermission("read"), async (c) => {
  const kind = c.req.query("kind");
  const resource = c.req.query("resource");
  if (!kind || !resource) {
    return c.json(
      {
        ok: false,
        error: {
          code: "validation-error",
          message: "kind and resource query params are required",
          retryable: false,
        },
      },
      400,
    );
  }
  const stub = c.get("doStub");
  return forwardToDO(
    stub,
    "/artifact/latest",
    "GET",
    undefined,
    { kind, resource },
    analyticsCtxFrom(c),
  );
});

// ---------------------------------------------------------------------------
// Grep candidate type (mirrors GrepCandidate from @tila/ops-sqlite but local)
// ---------------------------------------------------------------------------

interface GrepCandidate {
  r2_key: string;
  kind: string;
  resource: string | null;
  mime_type: string;
  bytes: number;
  content_inline: string | null;
}

// GET /projects/:projectId/artifacts/grep -- server-side content grep over artifacts
// Note: must be registered BEFORE the /:key{.+$} catch-all
artifacts.get("/grep", requirePermission("read"), async (c) => {
  // 1. Parse query params
  const raw = c.req.query();
  const parsed = ArtifactGrepQuerySchema.safeParse(raw);
  if (!parsed.success) return zodValidationError(c, parsed.error);

  const { pattern, kind, resource, regex, limit } = parsed.data;

  // 2. Compile matcher — catch catastrophic/invalid patterns before any I/O
  let matcher: ReturnType<typeof compileGrepMatcher>;
  try {
    validateGrepPattern(pattern, { regex });
    matcher = compileGrepMatcher(pattern, { regex });
  } catch (err) {
    if (err instanceof GrepQueryError) {
      return c.json(
        {
          ok: false,
          error: {
            code: "invalid-grep-pattern",
            message: err.message,
            retryable: false,
          },
        },
        400,
      );
    }
    throw err;
  }

  // 3. Fetch candidates from the DO
  const stub = c.get("doStub");
  const query: Record<string, string> = { limit: String(limit) };
  if (kind !== undefined) query.kind = kind;
  if (resource !== undefined) query.resource = resource;

  const { response: candidatesRes, json: candidatesBody } =
    await forwardTypedDO<{
      ok: true;
      candidates: GrepCandidate[];
    }>(
      stub,
      DO_PATHS.artifactGrepCandidates,
      "GET",
      undefined,
      query,
      analyticsCtxFrom(c),
    );

  if (!candidatesRes.ok) {
    return c.json(
      {
        ok: false,
        error: {
          code: "grep-candidates-failed",
          message: "Could not list artifacts to scan.",
          retryable: true,
        },
      },
      502,
    );
  }

  const { candidates } = candidatesBody;

  // 4. Scan loop
  const deadline = AbortSignal.timeout(GREP_DEADLINE_MS);

  type GrepResult = {
    key: string;
    kind: string;
    resource: string | null;
    lines: Array<{ line: number; text: string; col: number }>;
    truncated?: boolean;
  };

  const results: GrepResult[] = [];
  let scanned = 0;
  let skipped = 0;
  let truncated = false;
  let totalBytes = 0;
  let totalMatches = 0;

  // Separate candidates by inline vs R2-backed
  const inlineCandidates: GrepCandidate[] = [];
  const r2Candidates: GrepCandidate[] = [];

  for (const c2 of candidates) {
    if (c2.content_inline != null) {
      inlineCandidates.push(c2);
    } else {
      r2Candidates.push(c2);
    }
  }

  // ---------------------------------------------------------------------------
  // Shared line-scan accumulator — used by BOTH the inline path and the R2
  // path so cap/match-accounting logic lives in one place.
  //
  // Feed decoded string chunks via `pushChunk(decoded)`. When the blob is
  // fully consumed, call `flush()` to process the final pending line.
  //
  // Callers are responsible for tracking raw byte counts and setting
  // `blobTruncated` / `truncated` flags before calling `pushChunk` so the
  // accumulator can stop early.
  // ---------------------------------------------------------------------------

  function makeLineScanAccumulator() {
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
        if (totalMatches >= GREP_MAX_MATCHES) {
          truncated = true;
          break;
        }
        const hit = matchLine(matcher, line, lineNumber);
        if (hit) {
          blobLines.push(hit);
          blobMatches++;
          totalMatches++;
        }
      }
    }

    return {
      /** Feed a decoded string chunk. Returns true if scanning should stop. */
      pushChunk(decoded: string): boolean {
        if (blobTruncated || truncated) return true;
        const { lines, pending: newPending } = splitChunkIntoLines(
          pending,
          decoded,
        );
        pending = newPending;
        processLines(lines);
        return blobTruncated || truncated;
      },

      /** Flush the final pending line at EOF. */
      flush(): void {
        if (blobTruncated || truncated) return;
        if (pending) {
          lineNumber++;
          if (
            blobMatches < GREP_MAX_MATCHES_PER_BLOB &&
            totalMatches < GREP_MAX_MATCHES
          ) {
            const hit = matchLine(matcher, pending, lineNumber);
            if (hit) {
              blobLines.push(hit);
              blobMatches++;
              totalMatches++;
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

  // Process inline candidates first (0 R2 reads)
  for (const candidate of inlineCandidates) {
    if (
      deadline.aborted ||
      totalBytes >= GREP_TOTAL_BYTE_CAP ||
      totalMatches >= GREP_MAX_MATCHES
    ) {
      truncated = true;
      break;
    }

    const content = candidate.content_inline as string;
    const acc = makeLineScanAccumulator();
    // Run the inline content through the shared accumulator (one "chunk" + EOF flush)
    acc.pushChunk(content);
    acc.flush();

    if (acc.lines.length > 0) {
      results.push({
        key: candidate.r2_key,
        kind: candidate.kind,
        resource: candidate.resource,
        lines: acc.lines,
      });
    }
    scanned++;
  }

  // Process R2-backed candidates with ≤6 in-flight concurrency
  const CONCURRENCY = 6;

  async function scanR2Candidate(
    candidate: GrepCandidate,
  ): Promise<GrepResult | null> {
    try {
      const obj = await c.env.ARTIFACTS.get(candidate.r2_key);
      if (obj == null) {
        skipped++;
        return null;
      }

      // Read raw Uint8Array chunks from the R2 body to track RAW bytes pulled
      // from R2 (per design spec: GREP_PER_BLOB_BYTE_CAP / GREP_TOTAL_BYTE_CAP
      // are measured on raw bytes, tracking value.byteLength before decode).
      // A stateful TextDecoder handles multi-byte code points across chunk
      // boundaries without re-encoding.
      const rawReader = obj.body.getReader();
      const decoder = new TextDecoder("utf-8", { fatal: false });

      const acc = makeLineScanAccumulator();
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
          totalBytes += value.byteLength;

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
          if (totalBytes >= GREP_TOTAL_BYTE_CAP || deadline.aborted) {
            truncated = true;
          }

          if (acc.isBlobTruncated || truncated) break;
        }
      } finally {
        rawReader.cancel().catch(() => {});
      }

      // Flush the final pending line at EOF (accumulator handles the guard).
      acc.flush();

      scanned++;

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
      skipped++;
      return null;
    }
  }

  // Process R2 candidates in batches of ≤ CONCURRENCY
  for (let i = 0; i < r2Candidates.length; i += CONCURRENCY) {
    if (
      deadline.aborted ||
      totalBytes >= GREP_TOTAL_BYTE_CAP ||
      totalMatches >= GREP_MAX_MATCHES
    ) {
      truncated = true;
      break;
    }

    const batch = r2Candidates.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(batch.map(scanR2Candidate));

    for (const result of batchResults) {
      if (result != null) {
        results.push(result);
      }
    }
  }

  // Truncation: if DO returned exactly `limit` candidates, more may exist
  if (candidates.length >= limit) {
    truncated = true;
  }

  return c.json({
    ok: true,
    results,
    scanned,
    skipped,
    truncated,
  });
});

// GET /projects/:projectId/artifacts/search -- full-text search via DO FTS5
// Note: must be registered BEFORE the /:key{.+$} catch-all
artifacts.get("/search", requirePermission("read"), async (c) => {
  const raw = c.req.query();
  const parsed = ArtifactSearchQuerySchema.safeParse(raw);
  if (!parsed.success) return zodValidationError(c, parsed.error);

  const {
    q,
    kind,
    resource,
    source_only,
    limit,
    tag_filter: tagFilter,
  } = parsed.data;
  const query: Record<string, string> = { q };
  if (kind !== undefined) query.kind = kind;
  if (resource !== undefined) query.resource = resource;
  if (source_only) query.source_only = "true";
  if (limit !== undefined) query.limit = String(limit);
  if (tagFilter?.length) query.tag_filter = tagFilter.join(",");

  const stub = c.get("doStub");
  return forwardToDO(
    stub,
    "/artifact/search",
    "GET",
    undefined,
    query,
    analyticsCtxFrom(c),
  );
});

// POST /projects/:projectId/artifacts/relationship -- add artifact relationship
// Note: must be registered BEFORE the /:key{.+$} catch-all
artifacts.post("/relationship", requirePermission("write"), async (c) => {
  const parsed = ArtifactRelationshipRequestSchema.safeParse(
    await c.req.json(),
  );
  if (!parsed.success) return zodValidationError(c, parsed.error);
  const body = parsed.data;
  if (
    body.metadata !== undefined &&
    jsonByteLength(body.metadata) > ARTIFACT_METADATA_MAX_BYTES
  ) {
    return c.json(
      {
        ok: false,
        error: {
          code: "validation-error",
          message: "metadata is too large",
          retryable: false,
        },
      },
      400,
    );
  }
  const stub = c.get("doStub");

  // TOML-runtime type validation: if artifact_relationships.types is declared, validate against it
  // This is additive to any static enum check — when types is not declared, any type is accepted.
  const { json: schemaBody } = await forwardTypedDO<{
    ok: boolean;
    schema: { definition: string } | null;
  }>(
    stub,
    DO_PATHS.schemaCurrent,
    "GET",
    undefined,
    undefined,
    analyticsCtxFrom(c),
  );

  if (schemaBody.ok && schemaBody.schema?.definition) {
    try {
      const tomlParsed = TOML.parse(schemaBody.schema.definition);
      const schemaDef = TilaSchemaTomlSchema.safeParse(tomlParsed);
      if (schemaDef.success) {
        const declaredTypes = schemaDef.data.artifact_relationships?.types;
        if (declaredTypes && declaredTypes.length > 0) {
          if (!declaredTypes.includes(body.type)) {
            return c.json(
              {
                ok: false,
                error: {
                  code: "invalid-relationship-type",
                  message: `Type "${body.type}" is not declared in tila.schema.toml. Valid types: ${declaredTypes.join(", ")}`,
                  retryable: false,
                },
              },
              422,
            );
          }
        }
      }
    } catch {
      // TOML parse failure: log warning and allow through (permissive default)
      console.warn(
        "Failed to parse tila.schema.toml for relationship type validation",
      );
    }
  }
  // No schema or no types declared: allow any type (permissive default)

  const tokenResult = c.get("tokenResult");
  return forwardToDO(
    stub,
    "/artifact/relationship",
    "POST",
    {
      from_key: body.from_key,
      to_key: body.to_key,
      type: body.type,
      metadata: body.metadata ?? {},
      actor: tokenResult.name,
      actor_token_id: tokenResult.tokenId,
      source: c.get("source"),
      source_version: c.get("sourceVersion"),
    },
    undefined,
    analyticsCtxFrom(c),
  );
});

// GET /projects/:projectId/artifacts/index/entries -- list entries for an index
// Note: must be registered BEFORE the /:key{.+$} catch-all
artifacts.get("/index/entries", requirePermission("read"), async (c) => {
  const indexKey = c.req.query("index_key");
  if (!indexKey) {
    return c.json(
      {
        ok: false,
        error: {
          code: "bad-request",
          message: "index_key query param required",
          retryable: false,
        },
      },
      400,
    );
  }
  const stub = c.get("doStub");
  return forwardToDO(
    stub,
    "/artifact/index/entries",
    "GET",
    undefined,
    {
      index_key: indexKey,
    },
    analyticsCtxFrom(c),
  );
});

// GET /projects/:projectId/artifacts/:key/relationships -- list relationships for an artifact
// Note: must be registered BEFORE the /:key{.+$} catch-all
artifacts.get(
  "/:key{.+}/relationships",
  requirePermission("read"),
  async (c) => {
    const key = c.req.param("key");
    const stub = c.get("doStub");
    return forwardToDO(
      stub,
      "/artifact/relationships",
      "GET",
      undefined,
      {
        from_key: key,
      },
      analyticsCtxFrom(c),
    );
  },
);

// POST /projects/:projectId/artifacts/reconcile -- cross-backend orphan recovery
// Note: must be registered BEFORE the /:key{.+$} catch-all
artifacts.post("/reconcile", requirePermission("write"), async (c) => {
  const apply = c.req.query("apply") === "true";
  const r2 = new R2ArtifactBackend(c.env.ARTIFACTS);

  // List all R2 blobs with metadata under both prefixes
  const producedBlobs = await r2.listWithMetadata("produced/");
  const sourceBlobs = await r2.listWithMetadata("sources/");
  const allBlobs = [...producedBlobs, ...sourceBlobs];

  // Enrich blobs with search text for searchable MIME types.
  // Mirrors the search-rebuild pattern (buildRebuildCandidates).
  // Non-searchable and oversized blobs are returned unchanged.
  const SEARCHABLE_MIMES = new Set(["text/markdown", "text/plain"]);
  const enrichedBlobs: Array<
    (typeof allBlobs)[number] & {
      search_title?: string | null;
      search_body_text?: string | null;
    }
  > = [];
  for (let i = 0; i < allBlobs.length; i += RECONCILE_ENRICH_BATCH_SIZE) {
    const chunk = allBlobs.slice(i, i + RECONCILE_ENRICH_BATCH_SIZE);
    const enrichedChunk = await Promise.all(
      chunk.map(async (blob) => {
        const mimeType = blob.metadata["tila-mime"] ?? "";
        if (!SEARCHABLE_MIMES.has(mimeType)) return blob;
        try {
          const obj = await r2.get(blob.key);
          if (!obj) return blob;
          const arrayBuf = await new Response(obj.body).arrayBuffer();
          const normalized = normalizeArtifactText(arrayBuf, mimeType);
          if (!normalized) return blob;
          return {
            ...blob,
            search_title: normalized.title,
            search_body_text: normalized.body_text,
          };
        } catch {
          return blob;
        }
      }),
    );
    enrichedBlobs.push(...enrichedChunk);
  }

  const tokenResult = c.get("tokenResult");
  const stub = c.get("doStub");

  const { response: doResponse, json: doBody } = await forwardTypedDO<
    Record<string, unknown>
  >(
    stub,
    DO_PATHS.artifactReconcile,
    "POST",
    {
      r2_blobs: enrichedBlobs,
      apply,
      actor: tokenResult.name,
      actor_token_id: tokenResult.tokenId,
      source: c.get("source"),
      source_version: c.get("sourceVersion"),
    },
    undefined,
    analyticsCtxFrom(c),
  );

  // Phase 2 (C6): Cross-check R2 blob existence for non-tombstoned searchable pointers.
  // Repair: tombstone any searchable pointer whose R2 blob is missing.
  // R2 head() lives here (Worker has the R2 binding); ops-sqlite listSearchablePointers is blob-free.
  let repairErrors = 0;
  const { response: searchableRes, json: searchableBody } =
    await forwardTypedDO<{
      ok: boolean;
      pointers: Array<{
        r2_key: string;
        resource: string | null;
        kind: string;
        sha256: string;
      }>;
    }>(
      stub,
      DO_PATHS.artifactSearchablePointers,
      "GET",
      undefined,
      {
        limit: String(ARTIFACT_REPAIR_SCAN_LIMIT),
      },
      analyticsCtxFrom(c),
    );

  if (searchableRes.ok) {
    const { pointers } = searchableBody;

    for (const pointer of pointers) {
      let blobMissing = false;
      try {
        const headResult = await c.env.ARTIFACTS.head(pointer.r2_key);
        blobMissing = headResult === null;
      } catch (err) {
        console.error(`[reconcile] R2 head failed for ${pointer.r2_key}:`, err);
        repairErrors++;
        continue;
      }

      if (!blobMissing) continue;

      // Blob is missing — tombstone the dangling pointer
      try {
        await forwardToDO(
          stub,
          "/artifact/tombstone",
          "POST",
          {
            r2_key: pointer.r2_key,
            actor: tokenResult.name,
            actor_token_id: tokenResult.tokenId,
            source: c.get("source"),
            source_version: c.get("sourceVersion"),
          },
          undefined,
          analyticsCtxFrom(c),
        );
      } catch (err) {
        console.error(
          `[reconcile] tombstone repair failed for ${pointer.r2_key}:`,
          err,
        );
        repairErrors++;
      }
    }
  }

  return c.json({ ...doBody, repairErrors }, doResponse.status as 200);
});

// POST /projects/:projectId/artifacts/search-rebuild -- rebuild search docs from artifact pointers
// Note: must be registered BEFORE the /:key{.+$} catch-all
artifacts.post("/search-rebuild", requirePermission("write"), async (c) => {
  const apply = c.req.query("apply") === "true";
  const r2 = new R2ArtifactBackend(c.env.ARTIFACTS);
  const tokenResult = c.get("tokenResult");
  const stub = c.get("doStub");

  // Phase 1: Get pointer + search doc state from DO
  const { response: scanRes, json: scanBody } = await forwardTypedDO<{
    ok: boolean;
    pointers: ScanRow[];
  }>(
    stub,
    DO_PATHS.artifactSearchRebuildScan,
    "GET",
    undefined,
    undefined,
    analyticsCtxFrom(c),
  );
  if (!scanRes.ok) {
    return c.json(
      {
        ok: false as const,
        error: {
          code: "do-unreachable",
          message: `Backend scan returned ${scanRes.status}`,
          retryable: true,
        },
      },
      502,
    );
  }
  const { pointers } = scanBody;

  // Phase 2: Enrich candidates with R2 blob content where needed
  const candidates = await buildRebuildCandidates(r2, pointers);

  // Phase 3: Send enriched candidates to DO for rebuild
  const { response: doResponse, json: doBody } = await forwardTypedDO<
    Record<string, unknown>
  >(
    stub,
    DO_PATHS.artifactSearchRebuild,
    "POST",
    {
      candidates,
      apply,
      actor: tokenResult.name,
      actor_token_id: tokenResult.tokenId,
      source: c.get("source"),
      source_version: c.get("sourceVersion"),
    },
    undefined,
    analyticsCtxFrom(c),
  );

  return c.json(doBody, doResponse.status as 200);
});

// DELETE /projects/:projectId/artifacts/:key{.+$} -- tombstone-first delete
// Note: must be registered BEFORE the GET /:key{.+$} catch-all
artifacts.delete("/:key{.+$}", requirePermission("write"), async (c) => {
  const key = c.req.param("key");
  const tokenResult = c.get("tokenResult");
  const stub = c.get("doStub");
  const r2 = new R2ArtifactBackend(c.env.ARTIFACTS);

  // Step 1: Tombstone-first (DO pointer before R2 blob)
  const tombstoneRes = await forwardToDO(
    stub,
    "/artifact/tombstone",
    "POST",
    {
      r2_key: key,
      actor: tokenResult.name,
      actor_token_id: tokenResult.tokenId,
      source: c.get("source"),
      source_version: c.get("sourceVersion"),
    },
    undefined,
    analyticsCtxFrom(c),
  );
  if (!tombstoneRes.ok) {
    return c.json(
      {
        ok: false,
        error: {
          code: "tombstone-failed",
          message: `Backend cleanup returned ${tombstoneRes.status}`,
          retryable: true,
        },
      },
      502,
    );
  }

  // Step 2: R2 blob delete (best-effort after pointer tombstoned)
  try {
    await r2.delete(key);
  } catch (err) {
    console.error(`[delete] R2 delete failed for ${key}:`, err);
    return c.json({ ok: true, r2_orphaned: true });
  }

  return c.json({ ok: true });
});

// GET /projects/:projectId/artifacts/:key{.+} -- download from R2 (with inline fast path)
// Note: this must be registered AFTER all named routes to avoid matching them
artifacts.get("/:key{.+$}", requirePermission("read"), async (c) => {
  const key = c.req.param("key");

  // Inline fast path: check DO for content_inline before hitting R2
  const stub = c.get("doStub");
  const { response: metaRes, json: meta } = await forwardTypedDO<{
    ok: boolean;
    pointer?: { content_inline: string | null; mime_type: string } | null;
  }>(
    stub,
    DO_PATHS.artifactPointerMeta,
    "GET",
    undefined,
    { key },
    analyticsCtxFrom(c),
  );
  if (!metaRes.ok) {
    return c.json(
      {
        ok: false,
        error: {
          code: "not-found",
          message: `Artifact ${key} not found`,
          retryable: false,
        },
      },
      404,
    );
  }
  if (!meta.ok || !meta.pointer) {
    return c.json(
      {
        ok: false,
        error: {
          code: "not-found",
          message: `Artifact ${key} not found`,
          retryable: false,
        },
      },
      404,
    );
  }
  if (meta.pointer.content_inline != null) {
    return new Response(meta.pointer.content_inline, {
      headers: { "Content-Type": meta.pointer.mime_type },
    });
  }

  // R2 fallback
  const r2 = new R2ArtifactBackend(c.env.ARTIFACTS);
  const result = await r2.get(key);
  if (!result) {
    return c.json(
      {
        ok: false,
        error: {
          code: "not-found",
          message: `Artifact ${key} not found`,
          retryable: false,
        },
      },
      404,
    );
  }
  return new Response(result.body, {
    headers: {
      "Content-Type": result.contentType,
    },
  });
});
