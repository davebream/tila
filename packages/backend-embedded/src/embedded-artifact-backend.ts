import type {
  ArtifactBackend,
  ArtifactIndexEntry,
  ArtifactPointerRecord,
  ArtifactPutOptions,
  ArtifactRelationship,
  ArtifactSearchResultRecord,
} from "@tila/core";
import {
  GREP_MAX_MATCHES,
  GREP_MAX_MATCHES_PER_BLOB,
  GREP_PER_BLOB_BYTE_CAP,
  GREP_TOTAL_BYTE_CAP,
  compileGrepMatcher,
  matchLine,
  splitChunkIntoLines,
  validateGrepPattern,
} from "@tila/core";
import { artifactOps, relationshipOps, schema } from "@tila/ops-sqlite";
import type { ArtifactGrepResponse } from "@tila/schemas";
import { and, eq, like } from "drizzle-orm";

import type { BlobStore } from "./blob-store";
import type { EmbeddedDb } from "./embedded-project";
import { type SleepSync, withBusyRetry } from "./retry";

/**
 * Runtime-agnostic implementation of `ArtifactBackend`.
 *
 * Ported from `@tila/backend-local`'s `LocalArtifactBackend`, with all Bun I/O
 * (`Bun.write`, `Bun.file().stream()`, `Bun.readableStreamToArrayBuffer`)
 * replaced by an injected `BlobStore`. Metadata stays in SQLite
 * (`artifact_pointers`, shared schema from `@tila/ops-sqlite`).
 *
 * Content-addressing (sha256 → key derivation) lives ABOVE the `BlobStore` (R9):
 * the `ReadableStream` → buffer → sha256 logic is here, so the per-runtime
 * `BlobStore` implementations (bun, node) never re-implement and never drift on
 * sha256.
 *
 * The `r2_key` column stores the full relative path (e.g.
 * "org/project/abc123.txt") which satisfies the CHECK constraint
 * `r2_key LIKE '%/%'`.
 */
export class EmbeddedArtifactBackend implements ArtifactBackend {
  private readonly db: EmbeddedDb;
  private readonly blobs: BlobStore;
  private readonly _org: string;
  private readonly _project: string;
  private readonly sleepSync: SleepSync;

  constructor(opts: {
    db: EmbeddedDb;
    blobs: BlobStore;
    org: string;
    project: string;
    sleepSync: SleepSync;
  }) {
    this.db = opts.db;
    this.blobs = opts.blobs;
    this._org = opts.org;
    this._project = opts.project;
    this.sleepSync = opts.sleepSync;
  }

  private retry<T>(fn: () => T): T {
    return withBusyRetry(fn, this.sleepSync);
  }

  async put(
    options: ArtifactPutOptions,
  ): Promise<{ key: string; bytes: number }> {
    // 1. Resolve body to bytes (content-addressing stays above BlobStore)
    let bytes: Uint8Array;

    if (typeof options.body === "string") {
      bytes = new TextEncoder().encode(options.body);
    } else if (options.body instanceof ArrayBuffer) {
      bytes = new Uint8Array(options.body);
    } else {
      // ReadableStream -- consume to a single buffer
      bytes = await readStreamToBytes(options.body);
    }

    // 2. Write blob via the injected store
    const { bytes: written } = await this.blobs.write(options.key, bytes);

    // 3. Write metadata to SQLite (idempotent via INSERT OR IGNORE in upsertPointer)
    this.retry(() =>
      artifactOps.upsertPointer(
        this.db,
        {
          r2_key: options.key,
          resource: options.resource ?? null,
          kind: options.kind ?? this.deriveKind(options.contentType),
          sha256: options.sha256,
          bytes: written,
          fence: options.fence ?? null,
          mime_type: options.contentType,
          produced_at: Date.now(),
          produced_by: "local",
          expires_at: options.expiresAt ?? null,
        },
        { actor: "local" },
      ),
    );

    return { key: options.key, bytes: written };
  }

  async get(key: string): Promise<{
    body: ReadableStream;
    contentType: string;
    metadata: Record<string, string>;
  } | null> {
    const row = this.db
      .select()
      .from(schema.artifactPointers)
      .where(
        and(
          eq(schema.artifactPointers.r2_key, key),
          eq(schema.artifactPointers.tombstoned, 0),
        ),
      )
      .get();

    if (!row) return null;

    const stream = await this.blobs.readStream(key);
    if (!stream) return null;

    return {
      body: stream,
      contentType: row.mime_type,
      metadata: {}, // artifact_pointers has no metadata column
    };
  }

  async list(prefix: string): Promise<{ key: string; size: number }[]> {
    const rows = this.db
      .select({
        key: schema.artifactPointers.r2_key,
        size: schema.artifactPointers.bytes,
      })
      .from(schema.artifactPointers)
      .where(
        and(
          like(schema.artifactPointers.r2_key, `${prefix}%`),
          eq(schema.artifactPointers.tombstoned, 0),
        ),
      )
      .all();

    return rows.map((r) => ({ key: r.key, size: r.size }));
  }

  async delete(key: string): Promise<void> {
    // Soft tombstone, matching DO behavior. Physical blob cleanup via sweepOps.
    this.retry(() =>
      artifactOps.tombstonePointer(this.db, key, { actor: "local" }),
    );
  }

  async listWithMetadata(
    prefix: string,
  ): Promise<
    { key: string; size: number; metadata: Record<string, string> }[]
  > {
    const items = await this.list(prefix);
    return items.map((item) => ({ ...item, metadata: {} }));
  }

  async listPointers(query: {
    resource?: string;
    kind?: string;
  }): Promise<ArtifactPointerRecord[]> {
    const rows = artifactOps.listPointers(this.db, query);
    return rows.map((r) => ({
      r2_key: r.r2_key,
      resource: r.resource,
      kind: r.kind,
      sha256: r.sha256,
      bytes: r.bytes,
      mime_type: r.mime_type,
      produced_at: r.produced_at,
      produced_by: r.produced_by,
      expires_at: r.expires_at,
      tombstoned: r.tombstoned,
    }));
  }

  async addRelationship(
    fromKey: string,
    toKeyOrUri: { to_key?: string; to_uri?: string },
    type: string,
  ): Promise<void> {
    this.retry(() => {
      if (toKeyOrUri.to_key) {
        artifactOps.addArtifactRelationship(
          this.db,
          fromKey,
          toKeyOrUri.to_key,
          type,
          {},
          { actor: "local" },
        );
      } else if (toKeyOrUri.to_uri) {
        relationshipOps.insertArtifactRelationship(
          this.db,
          {
            from_key: fromKey,
            to_uri: toKeyOrUri.to_uri,
            type,
          },
          "local",
        );
      }
    });
  }

  async listRelationships(key: string): Promise<ArtifactRelationship[]> {
    const rows = relationshipOps.listArtifactRelationships(this.db, {
      from_key: key,
    });
    return rows.map((r) => ({
      from_key: r.from_key,
      to_key: r.to_key,
      to_uri: r.to_uri,
      type: r.type,
      created_at: r.created_at,
    }));
  }

  async searchArtifacts(query: {
    q: string;
    kind?: string;
    resource?: string;
    limit?: number;
  }): Promise<ArtifactSearchResultRecord[]> {
    const rows = artifactOps.searchArtifacts(this.db, query);
    return rows.map((r) => ({
      r2_key: r.r2_key,
      kind: r.kind,
      title: r.title ?? null,
      snippet: r.snippet ?? null,
    }));
  }

  async grepArtifacts(query: {
    pattern: string;
    kind?: string;
    resource?: string;
    regex?: boolean;
    limit?: number;
  }): Promise<ArtifactGrepResponse> {
    const { pattern, kind, resource, regex = false, limit } = query;

    // Validate the pattern (throws GrepQueryError on invalid regex patterns)
    validateGrepPattern(pattern, { regex });

    // Compile the matcher once
    const matcher = compileGrepMatcher(pattern, { regex });

    // Get candidates from SQLite (includes content_inline for ≤64KB fast path)
    const candidates = artifactOps.listGrepCandidates(this.db, {
      kind,
      resource,
      limit,
      now: Date.now(),
    });

    const results: ArtifactGrepResponse["results"] = [];
    let scanned = 0;
    let skipped = 0;
    let truncated = false;
    let totalMatches = 0;
    let totalBytes = 0;

    for (const candidate of candidates) {
      // Stop early if total caps are hit
      if (
        totalBytes >= GREP_TOTAL_BYTE_CAP ||
        totalMatches >= GREP_MAX_MATCHES
      ) {
        truncated = true;
        break;
      }

      const lines: { line: number; text: string; col: number }[] = [];
      let blobTruncated = false;
      let blobMatches = 0;

      if (candidate.content_inline !== null) {
        // Fast path: inline content — zero blob-store reads
        let pending = "";
        let lineNum = 0;

        const { lines: completedLines, pending: newPending } =
          splitChunkIntoLines(pending, candidate.content_inline);
        pending = newPending;

        for (const lineText of completedLines) {
          lineNum++;
          if (blobMatches >= GREP_MAX_MATCHES_PER_BLOB) {
            blobTruncated = true;
            break;
          }
          const hit = matchLine(matcher, lineText, lineNum);
          if (hit) {
            lines.push(hit);
            blobMatches++;
            totalMatches++;
          }
        }

        // Flush trailing partial line (EOF)
        if (!blobTruncated && pending.length > 0) {
          lineNum++;
          if (blobMatches < GREP_MAX_MATCHES_PER_BLOB) {
            const hit = matchLine(matcher, pending, lineNum);
            if (hit) {
              lines.push(hit);
              blobMatches++;
              totalMatches++;
            }
          }
        }

        scanned++;

        if (lines.length > 0 || blobTruncated) {
          results.push({
            key: candidate.r2_key,
            kind: candidate.kind,
            resource: candidate.resource,
            lines,
            ...(blobTruncated ? { truncated: true } : {}),
          });
        }
      } else {
        // Blob path — read from the injected store
        const stream = await this.blobs.readStream(candidate.r2_key);
        if (!stream) {
          skipped++;
          continue;
        }

        try {
          const decoder = new TextDecoder("utf-8", { fatal: false });
          let pending = "";
          let lineNum = 0;
          let blobBytes = 0;

          const reader = stream.getReader();
          let done = false;

          while (!done) {
            const { done: chunkDone, value: chunk } = await reader.read();
            done = chunkDone;

            // Decode any buffered data. When `done` is true, flush the decoder
            // (stream: false) even if chunk is undefined.
            const decodedChunk =
              chunk !== undefined
                ? decoder.decode(chunk, { stream: !done })
                : done
                  ? decoder.decode(undefined, { stream: false })
                  : "";

            if (chunk !== undefined) {
              blobBytes += chunk.byteLength;
              totalBytes += chunk.byteLength;
            }

            if (decodedChunk.length > 0) {
              const { lines: completedLines, pending: newPending } =
                splitChunkIntoLines(pending, decodedChunk);
              pending = newPending;

              for (const lineText of completedLines) {
                lineNum++;
                if (blobMatches >= GREP_MAX_MATCHES_PER_BLOB) {
                  blobTruncated = true;
                  break;
                }
                if (totalMatches >= GREP_MAX_MATCHES) {
                  truncated = true;
                  blobTruncated = true;
                  break;
                }
                const hit = matchLine(matcher, lineText, lineNum);
                if (hit) {
                  lines.push(hit);
                  blobMatches++;
                  totalMatches++;
                }
              }

              if (blobTruncated) {
                reader.cancel();
                break;
              }
            }

            if (chunk !== undefined) {
              if (blobBytes >= GREP_PER_BLOB_BYTE_CAP) {
                blobTruncated = true;
                reader.cancel();
                break;
              }

              if (totalBytes >= GREP_TOTAL_BYTE_CAP) {
                truncated = true;
                reader.cancel();
                break;
              }
            }
          }

          // Flush trailing partial line at EOF (only if not truncated)
          if (!blobTruncated && pending.length > 0) {
            lineNum++;
            if (
              blobMatches < GREP_MAX_MATCHES_PER_BLOB &&
              totalMatches < GREP_MAX_MATCHES
            ) {
              const hit = matchLine(matcher, pending, lineNum);
              if (hit) {
                lines.push(hit);
                blobMatches++;
                totalMatches++;
              }
            }
          }

          scanned++;

          if (lines.length > 0 || blobTruncated) {
            results.push({
              key: candidate.r2_key,
              kind: candidate.kind,
              resource: candidate.resource,
              lines,
              ...(blobTruncated ? { truncated: true } : {}),
            });
          }
        } catch {
          // Any read error — count as skipped, never abort the request
          skipped++;
        }
      }
    }

    return { ok: true, results, scanned, skipped, truncated };
  }

  async listIndexEntries(indexKey: string): Promise<ArtifactIndexEntry[]> {
    return artifactOps.listIndexEntries(this.db, indexKey);
  }

  // ---------- New optional methods (implementation gap from the interface) ----------

  /**
   * Latest (chain-head) artifact pointer for a `(kind, resource)` pair.
   * Delegates to `artifactOps.getLatestPointer`. The interface return type
   * (`ArtifactPointerRecord`) has no `tags`, so the pointer's tags are dropped.
   */
  async getLatest(
    kind: string,
    resource: string,
  ): Promise<ArtifactPointerRecord | null> {
    const ptr = artifactOps.getLatestPointer(this.db, kind, resource);
    if (!ptr) return null;
    return {
      r2_key: ptr.r2_key,
      resource: ptr.resource,
      kind: ptr.kind,
      sha256: ptr.sha256,
      bytes: ptr.bytes,
      mime_type: ptr.mime_type,
      produced_at: ptr.produced_at,
      produced_by: ptr.produced_by,
      expires_at: ptr.expires_at,
      tombstoned: ptr.tombstoned,
    };
  }

  /**
   * Write text content as a content-addressed artifact. Computes sha256 over the
   * raw text bytes (content-addressing above the BlobStore), derives the key
   * `<org>/<project>/<sha256>.<ext>`, and `put`s it.
   */
  async writeText(
    content: string,
    opts: {
      kind: string;
      mimeType?: string;
      resource?: string;
      fence?: number;
    },
  ): Promise<{ key: string; bytes: number }> {
    const mimeType = opts.mimeType ?? "text/plain";
    const sha256 = await sha256Hex(content);
    const ext = extForMime(mimeType);
    const key = `${this._org}/${this._project}/${sha256}.${ext}`;

    return this.put({
      key,
      body: content,
      sha256,
      metadata: {},
      contentType: mimeType,
      kind: opts.kind,
      resource: opts.resource,
      fence: opts.fence,
    });
  }

  /**
   * Read an artifact's text content + mime type by key, or null if absent
   * (tombstoned pointer or missing blob).
   */
  async readText(
    key: string,
  ): Promise<{ content: string; mimeType: string } | null> {
    const row = this.db
      .select()
      .from(schema.artifactPointers)
      .where(
        and(
          eq(schema.artifactPointers.r2_key, key),
          eq(schema.artifactPointers.tombstoned, 0),
        ),
      )
      .get();
    if (!row) return null;

    const content = await this.blobs.read(key);
    if (content === null) return null;

    return { content, mimeType: row.mime_type };
  }

  /**
   * Derive artifact kind from content type.
   * Matches the kind values used in the DO backend.
   */
  private deriveKind(contentType: string): string {
    if (contentType.startsWith("text/")) return "text";
    if (contentType === "application/json") return "json";
    if (contentType === "application/toml") return "toml";
    return "blob";
  }
}

// ---------------------------------------------------------------------------
// Content-addressing helpers (kept here, above the BlobStore, per R9)
// ---------------------------------------------------------------------------

/** Hex sha256 of a utf-8 string via the web-standard SubtleCrypto. */
async function sha256Hex(content: string): Promise<string> {
  const encoded = new TextEncoder().encode(content);
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Consume a WHATWG ReadableStream into a single Uint8Array. */
async function readStreamToBytes(stream: ReadableStream): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = value as Uint8Array;
    chunks.push(chunk);
    total += chunk.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** Map a mime type to a file extension for the content-addressed key. */
function extForMime(mimeType: string): string {
  if (mimeType === "application/json") return "json";
  if (mimeType === "application/toml") return "toml";
  if (mimeType.startsWith("text/")) return "txt";
  return "bin";
}
