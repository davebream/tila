import type { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
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
import type { ArtifactGrepResponse } from "@tila/schemas";
import { and, eq, like } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";

import { artifactOps, relationshipOps, schema } from "@tila/ops-sqlite";
import { withBusyRetry } from "./retry";

/**
 * Local filesystem implementation of ArtifactBackend.
 *
 * Blobs stored at: <artifactsRoot>/<key>
 * where key format is: <org>/<project>/<sha256>.<ext>
 *
 * Metadata stored in SQLite `artifact_pointers` table (shared schema from @tila/ops-sqlite).
 *
 * The `r2_key` column stores the full relative path (e.g., "org/project/abc123.txt")
 * which satisfies the CHECK constraint `r2_key LIKE '%/%'`.
 */
export class LocalArtifactBackend implements ArtifactBackend {
  constructor(
    private db: BunSQLiteDatabase<typeof schema> & { $client: Database },
    private artifactsRoot: string,
    private _org: string,
    private _project: string,
  ) {}

  async put(
    options: ArtifactPutOptions,
  ): Promise<{ key: string; bytes: number }> {
    // 1. Resolve body to bytes
    let bytes: Uint8Array;

    if (typeof options.body === "string") {
      bytes = new TextEncoder().encode(options.body);
    } else if (options.body instanceof ArrayBuffer) {
      bytes = new Uint8Array(options.body);
    } else {
      // ReadableStream -- consume to ArrayBuffer (only async operation in this method)
      const ab = await Bun.readableStreamToArrayBuffer(options.body);
      bytes = new Uint8Array(ab);
    }

    // 2. Write blob to filesystem
    const blobPath = join(this.artifactsRoot, options.key);
    const blobDir = dirname(blobPath);
    mkdirSync(blobDir, { recursive: true });
    await Bun.write(blobPath, bytes);

    // 3. Write metadata to SQLite (idempotent via INSERT OR IGNORE in upsertPointer)
    withBusyRetry(() =>
      artifactOps.upsertPointer(
        this.db,
        {
          r2_key: options.key,
          resource: null, // local artifacts are not resource-scoped by default
          kind: this.deriveKind(options.contentType),
          sha256: options.sha256,
          bytes: bytes.byteLength,
          fence: null,
          mime_type: options.contentType,
          produced_at: Date.now(),
          produced_by: "local",
          expires_at: null,
        },
        { actor: "local" },
      ),
    );

    return { key: options.key, bytes: bytes.byteLength };
  }

  async get(key: string): Promise<{
    body: ReadableStream;
    contentType: string;
    metadata: Record<string, string>;
  } | null> {
    // Look up pointer in SQLite using schema tables directly
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

    // Check blob exists on disk
    const blobPath = join(this.artifactsRoot, key);
    const file = Bun.file(blobPath);
    if (!(await file.exists())) return null;

    return {
      body: file.stream() as unknown as ReadableStream,
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
    // Soft tombstone, matching DO behavior. Physical file cleanup via sweepOps.
    withBusyRetry(() =>
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
    withBusyRetry(() => {
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
        // Local blob path — read from filesystem
        const blobPath = join(this.artifactsRoot, candidate.r2_key);
        const file = Bun.file(blobPath);

        const exists = await file.exists();
        if (!exists) {
          skipped++;
          continue;
        }

        try {
          // Read blob as text; bun:sqlite artifacts are always text in practice
          // but we handle as stream to respect per-blob byte cap
          const stream = file.stream();
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
