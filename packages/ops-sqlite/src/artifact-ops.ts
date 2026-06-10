import { GREP_CANDIDATE_CAP, GREP_INLINE_RESPONSE_BUDGET } from "@tila/core";
import type {
  ArtifactPointer,
  ArtifactSearchResult,
  JournalEventKind,
} from "@tila/schemas";
import { TagsSchema } from "@tila/schemas";
import {
  type SQL,
  and,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { assertResourceFence } from "./fence-ops";
import { type RequestOrigin, appendJournal } from "./journal-ops";
import * as schema from "./schema";
import { tagExistsConditions } from "./tag-filter-ops";

/**
 * Thrown when an FTS5 MATCH query has invalid syntax.
 * The route handler catches this and returns a 400 response.
 */
export class SearchQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SearchQueryError";
  }
}

export function upsertPointer(
  db: BaseSQLiteDatabase<"sync", unknown, typeof schema>,
  pointer: {
    r2_key: string;
    resource: string | null;
    kind: string;
    sha256: string;
    bytes: number;
    fence: number | null;
    mime_type: string;
    produced_at: number;
    produced_by: string;
    expires_at: number | null;
    content_inline?: string | null;
  },
  origin: RequestOrigin,
  journalKind?: JournalEventKind,
  searchText?: { title: string | null; body_text: string } | null,
  autoSupersedes?: boolean,
  tags?: string[],
): void {
  // Validate + normalize tags outside the transaction to avoid holding the lock
  const normalizedTags =
    tags !== undefined ? (TagsSchema.parse(tags) as string[]) : undefined;

  db.transaction((tx) => {
    // Fence validation is skipped only for source artifacts (resource=null)
    // and explicitly unfenced uploads.
    if (pointer.fence !== null && pointer.resource !== null) {
      assertResourceFence(tx, pointer.resource, pointer.fence);
    }

    // INSERT OR IGNORE -- idempotent for content-addressed artifacts
    tx.run(
      sql`INSERT OR IGNORE INTO artifact_pointers(r2_key, resource, kind, sha256, bytes, fence, mime_type, produced_at, produced_by, expires_at, tombstoned, content_inline) VALUES(${pointer.r2_key}, ${pointer.resource}, ${pointer.kind}, ${pointer.sha256}, ${pointer.bytes}, ${pointer.fence}, ${pointer.mime_type}, ${pointer.produced_at}, ${pointer.produced_by}, ${pointer.expires_at}, 0, ${pointer.content_inline ?? null})`,
    );

    // Tags: on re-upsert of an existing r2_key (content-addressed; INSERT OR IGNORE
    // is a no-op), delete-all-then-reinsert ONLY when tags provided; preserve when undefined.
    if (normalizedTags !== undefined) {
      tx.run(
        sql`DELETE FROM artifact_tags WHERE artifact_key = ${pointer.r2_key}`,
      );
      for (const tag of normalizedTags) {
        tx.insert(schema.artifactTags)
          .values({ artifact_key: pointer.r2_key, tag })
          .run();
      }
    }

    // Conditional search doc insert -- atomic with pointer write.
    // INSERT OR IGNORE mirrors pointer idempotency: re-upload of same
    // content-addressed r2_key is a no-op. FTS5 triggers (asd_ai) fire
    // automatically on insert. tombstoned defaults to 0; T12 owns propagation.
    if (searchText != null) {
      const indexedAt = Date.now();
      tx.run(
        sql`INSERT OR IGNORE INTO artifact_search_docs(
          artifact_key, kind, mime_type, resource, title, body_text,
          indexed_at, source_sha256, tombstoned
        ) VALUES(
          ${pointer.r2_key}, ${pointer.kind}, ${pointer.mime_type},
          ${pointer.resource}, ${searchText.title}, ${searchText.body_text},
          ${indexedAt}, ${pointer.sha256}, 0
        )`,
      );
    }

    // Auto-supersedes: create supersedes relationships from the new pointer to all
    // existing non-tombstoned pointers with matching (kind, resource).
    // Direction convention: from_key = new (superseder), to_key = old (superseded).
    // Uses inline SQL with ALL required columns -- do NOT use addArtifactRelationship
    // which omits the required `target` column.
    if (autoSupersedes === true && pointer.resource !== null) {
      const existingPointers = tx.all<{ r2_key: string }>(
        sql`SELECT r2_key FROM artifact_pointers WHERE kind = ${pointer.kind} AND resource = ${pointer.resource} AND tombstoned = 0 AND r2_key != ${pointer.r2_key}`,
      );
      const now = Date.now();
      for (const old of existingPointers) {
        tx.run(
          sql`INSERT OR IGNORE INTO artifact_relationships(from_key, to_key, to_uri, type, target, metadata, created_at) VALUES(${pointer.r2_key}, ${old.r2_key}, NULL, 'supersedes', ${old.r2_key}, '{}', ${now})`,
        );
      }
    }

    appendJournal(tx, {
      kind: journalKind ?? "artifact.produced",
      resource: pointer.resource ?? "source",
      actor: origin.actor,
      fence: pointer.fence,
      tokenId: origin.tokenId,
      source: origin.source,
      sourceVersion: origin.sourceVersion,
    });
  });
}

/**
 * Returns the latest (chain-head) artifact pointer for a given (kind, resource) pair.
 *
 * Algorithm: Find pointers with matching (kind, resource), tombstoned=0, whose r2_key
 * is NOT a `to_key` in any `supersedes` relationship within the same (kind, resource) scope.
 * This finds the pointer that has NOT been superseded — the chain head.
 *
 * If multiple chain heads exist (disjoint chains), returns the one with the most recent
 * `produced_at`. If no supersedes relationships exist (no chain), this reduces to
 * selecting the most recent pointer by `produced_at`.
 *
 * Returns null if no non-tombstoned pointers exist for the given (kind, resource).
 */
export function getLatestPointer(
  db: BaseSQLiteDatabase<"sync", unknown, typeof schema>,
  kind: string,
  resource: string,
): ArtifactPointer | null {
  // NOTE: use `db.all(...)[0]` rather than `db.get(...)`. Under
  // `drizzle-orm/bun-sqlite`, `db.get(sql\`raw\`)` returns a POSITIONAL array
  // (not a column-keyed object), so `row.r2_key` would be undefined in the
  // embedded backend. `db.all(...)` returns column-keyed objects across every
  // sync driver (DO cf-workers, bun:sqlite, better-sqlite3). `LIMIT 1` keeps it
  // single-row.
  const rows = db.all<{
    r2_key: string;
    resource: string | null;
    kind: string;
    sha256: string;
    bytes: number;
    fence: number | null;
    mime_type: string;
    produced_at: number;
    produced_by: string;
    expires_at: number | null;
    tombstoned: number;
  }>(
    sql`SELECT p.r2_key, p.resource, p.kind, p.sha256, p.bytes, p.fence, p.mime_type, p.produced_at, p.produced_by, p.expires_at, p.tombstoned
        FROM artifact_pointers p
        WHERE p.kind = ${kind} AND p.resource = ${resource} AND p.tombstoned = 0
        AND p.r2_key NOT IN (
          SELECT r.to_key FROM artifact_relationships r
          WHERE r.type = 'supersedes'
          AND r.to_key IN (
            SELECT p2.r2_key FROM artifact_pointers p2
            WHERE p2.kind = ${kind} AND p2.resource = ${resource} AND p2.tombstoned = 0
          )
        )
        ORDER BY p.produced_at DESC
        LIMIT 1`,
  );

  const row = rows[0];
  if (!row) return null;

  // Read tags for this pointer (single query)
  const tagRows = db
    .select()
    .from(schema.artifactTags)
    .where(eq(schema.artifactTags.artifact_key, row.r2_key))
    .all();

  return {
    r2_key: row.r2_key,
    resource: row.resource,
    kind: row.kind,
    sha256: row.sha256,
    bytes: row.bytes,
    fence: row.fence,
    mime_type: row.mime_type,
    produced_at: row.produced_at,
    produced_by: row.produced_by,
    expires_at: row.expires_at,
    tombstoned: row.tombstoned,
    tags: tagRows.map((t) => t.tag),
  };
}

export function listPointers(
  db: BaseSQLiteDatabase<"sync", unknown, typeof schema>,
  query: {
    resource?: string;
    kind?: string | string[];
    limit?: number;
    tag?: string;
    tagFilter?: string[];
  },
): ArtifactPointer[] {
  const conditions: SQL[] = [eq(schema.artifactPointers.tombstoned, 0)];

  if (query.resource !== undefined) {
    conditions.push(eq(schema.artifactPointers.resource, query.resource));
  }
  if (query.kind) {
    if (Array.isArray(query.kind)) {
      conditions.push(inArray(schema.artifactPointers.kind, query.kind));
    } else {
      conditions.push(eq(schema.artifactPointers.kind, query.kind));
    }
  }
  if (query.tag) {
    conditions.push(
      sql`EXISTS (SELECT 1 FROM artifact_tags at WHERE at.artifact_key = ${schema.artifactPointers.r2_key} AND at.tag = ${query.tag})`,
    );
  }
  if (query.tagFilter?.length) {
    const normalizedTags = query.tagFilter.map((t) => t.toLowerCase());
    conditions.push(
      ...tagExistsConditions(
        "artifact_tags",
        sql`jt.artifact_key = ${schema.artifactPointers.r2_key}`,
        normalizedTags,
      ),
    );
  }

  const rows = db
    .select()
    .from(schema.artifactPointers)
    .where(and(...conditions))
    .limit(query.limit ?? 100)
    .all();

  if (rows.length === 0) return [];

  // Batch-enrich tags with a single query (no N+1)
  const r2Keys = rows.map((r) => r.r2_key);
  const tagRows = db
    .select()
    .from(schema.artifactTags)
    .where(inArray(schema.artifactTags.artifact_key, r2Keys))
    .all();

  // Group tags by artifact_key
  const tagsByKey = new Map<string, string[]>();
  for (const t of tagRows) {
    let arr = tagsByKey.get(t.artifact_key);
    if (!arr) {
      arr = [];
      tagsByKey.set(t.artifact_key, arr);
    }
    arr.push(t.tag);
  }

  return rows.map((row) => ({
    r2_key: row.r2_key,
    resource: row.resource,
    kind: row.kind,
    sha256: row.sha256,
    bytes: row.bytes,
    fence: row.fence,
    mime_type: row.mime_type,
    produced_at: row.produced_at,
    produced_by: row.produced_by,
    expires_at: row.expires_at,
    tombstoned: row.tombstoned,
    tags: tagsByKey.get(row.r2_key) ?? [],
  }));
}

/**
 * Candidate row for server-side artifact grep.
 * Includes `content_inline` for the ≤64KB fast path (zero R2 subrequests).
 */
export interface GrepCandidate {
  r2_key: string;
  kind: string;
  resource: string | null;
  mime_type: string;
  bytes: number;
  content_inline: string | null;
}

/**
 * List artifact pointer rows suitable for the grep scan loop.
 *
 * Applies:
 * - `tombstoned = 0` (always)
 * - optional `resource` / `kind` narrowing (mirrors `listPointers`)
 * - optional `(expires_at IS NULL OR expires_at > now)` when `now` is supplied
 * - `limit` clamped to `GREP_CANDIDATE_CAP` (100)
 * - inline-byte budget: once cumulative `content_inline` byte length exceeds
 *   `GREP_INLINE_RESPONSE_BUDGET` (8 MiB), subsequent rows have their
 *   `content_inline` set to `null` so the Worker fetches them from R2 instead.
 *   The `r2_key` and `bytes` fields are always preserved.
 */
export function listGrepCandidates(
  db: BaseSQLiteDatabase<"sync", unknown, typeof schema>,
  query: {
    resource?: string;
    kind?: string | string[];
    limit?: number;
    now?: number;
  },
): GrepCandidate[] {
  const conditions: SQL[] = [eq(schema.artifactPointers.tombstoned, 0)];

  if (query.resource !== undefined) {
    conditions.push(eq(schema.artifactPointers.resource, query.resource));
  }
  if (query.kind) {
    if (Array.isArray(query.kind)) {
      conditions.push(inArray(schema.artifactPointers.kind, query.kind));
    } else {
      conditions.push(eq(schema.artifactPointers.kind, query.kind));
    }
  }
  if (query.now !== undefined) {
    conditions.push(
      or(
        isNull(schema.artifactPointers.expires_at),
        gt(schema.artifactPointers.expires_at, query.now),
      ) as SQL,
    );
  }

  const limit = Math.min(query.limit ?? GREP_CANDIDATE_CAP, GREP_CANDIDATE_CAP);

  const rows = db
    .select({
      r2_key: schema.artifactPointers.r2_key,
      kind: schema.artifactPointers.kind,
      resource: schema.artifactPointers.resource,
      mime_type: schema.artifactPointers.mime_type,
      bytes: schema.artifactPointers.bytes,
      content_inline: schema.artifactPointers.content_inline,
    })
    .from(schema.artifactPointers)
    .where(and(...conditions))
    .orderBy(schema.artifactPointers.produced_at)
    .limit(limit)
    .all();

  // Apply inline-byte budget: accumulate content_inline byte lengths in row order
  // (stable produced_at order). Once cumulative bytes exceed GREP_INLINE_RESPONSE_BUDGET,
  // null out content_inline on that row and all subsequent rows (their r2_key and bytes
  // are preserved so the Worker fetches them from R2 instead).
  let cumulativeInlineBytes = 0;

  return rows.map((row) => {
    let inline = row.content_inline;
    if (inline !== null) {
      const byteLen = Buffer.byteLength(inline, "utf8");
      cumulativeInlineBytes += byteLen;
      if (cumulativeInlineBytes > GREP_INLINE_RESPONSE_BUDGET) {
        inline = null;
      }
    }
    return {
      r2_key: row.r2_key,
      kind: row.kind,
      resource: row.resource ?? null,
      mime_type: row.mime_type,
      bytes: row.bytes,
      content_inline: inline,
    };
  });
}

export function listExpiredPointers(
  db: BaseSQLiteDatabase<"sync", unknown, typeof schema>,
  now: number,
  limit: number,
): ArtifactPointer[] {
  const rows = db
    .select()
    .from(schema.artifactPointers)
    .where(
      and(
        isNotNull(schema.artifactPointers.expires_at),
        lte(schema.artifactPointers.expires_at, now),
        eq(schema.artifactPointers.tombstoned, 0),
      ),
    )
    .limit(limit)
    .all();

  return rows.map((row) => ({
    r2_key: row.r2_key,
    resource: row.resource,
    kind: row.kind,
    sha256: row.sha256,
    bytes: row.bytes,
    fence: row.fence,
    mime_type: row.mime_type,
    produced_at: row.produced_at,
    produced_by: row.produced_by,
    expires_at: row.expires_at,
    tombstoned: row.tombstoned,
    tags: [],
  }));
}

export function tombstonePointer(
  db: BaseSQLiteDatabase<"sync", unknown, typeof schema>,
  r2Key: string,
  origin: RequestOrigin,
  journalKind?: JournalEventKind,
): void {
  db.transaction((tx) => {
    const now = Date.now();
    tx.update(schema.artifactPointers)
      .set({ tombstoned: 1, tombstoned_at: now })
      .where(eq(schema.artifactPointers.r2_key, r2Key))
      .run();

    // Delete search doc if one exists. No-op when the artifact was never indexed
    // (non-searchable kind, unsupported MIME, or uploaded before T5).
    // The asd_ad trigger (MIGRATION_0003) fires automatically on this DELETE,
    // removing the corresponding row from artifact_search_docs_fts.
    tx.run(sql`DELETE FROM artifact_search_docs WHERE artifact_key = ${r2Key}`);

    appendJournal(tx, {
      kind: journalKind ?? "artifact.tombstoned",
      resource: r2Key,
      actor: origin.actor,
      fence: null,
      tokenId: origin.tokenId,
      source: origin.source,
      sourceVersion: origin.sourceVersion,
    });
  });
}

/**
 * Hard-deletes artifact pointer rows that have been tombstoned past the grace window.
 *
 * Rows are only deleted when:
 *   - tombstoned = 1 (marker set)
 *   - tombstoned_at IS NOT NULL (stamped by tombstonePointer after migration 0016)
 *   - tombstoned_at < cutoff (past the grace window)
 *
 * Rows tombstoned before the migration have tombstoned_at = NULL and remain inert
 * until re-tombstoned (acceptable: they hold no live R2 blob).
 *
 * Returns the number of rows deleted.
 */
export function deleteTombstonedPointers(
  db: BaseSQLiteDatabase<"sync", unknown, typeof schema>,
  cutoff: number,
): number {
  return db.transaction((tx) => {
    // Explicitly delete artifact_tags BEFORE the pointer delete, using the
    // same predicate subquery. ON DELETE CASCADE is inert in the DO (FK enforcement
    // is off in production), so this explicit delete is required to prevent orphans.
    tx.run(
      sql`DELETE FROM artifact_tags
          WHERE artifact_key IN (
            SELECT r2_key FROM artifact_pointers
            WHERE tombstoned = 1
              AND tombstoned_at IS NOT NULL
              AND tombstoned_at < ${cutoff}
          )`,
    );

    tx.run(
      sql`DELETE FROM artifact_pointers
          WHERE tombstoned = 1
            AND tombstoned_at IS NOT NULL
            AND tombstoned_at < ${cutoff}`,
    );
    return tx.get<{ n: number }>(sql`SELECT changes() AS n`)?.n ?? 0;
  });
}

export function addArtifactRelationship(
  db: BaseSQLiteDatabase<"sync", unknown, typeof schema>,
  fromKey: string,
  toKey: string,
  type: string,
  metadata: Record<string, unknown>,
  origin: RequestOrigin,
): void {
  db.transaction((tx) => {
    const now = Date.now();
    const metadataJson = JSON.stringify(metadata);

    // Primary edge: from -> to with the given type
    tx.run(
      sql`INSERT OR IGNORE INTO artifact_relationships(from_key, to_key, type, metadata, created_at) VALUES(${fromKey}, ${toKey}, ${type}, ${metadataJson}, ${now})`,
    );

    // Bidirectional edge for entry-of: also write the index-of reverse edge
    if (type === "entry-of") {
      tx.run(
        sql`INSERT OR IGNORE INTO artifact_relationships(from_key, to_key, type, metadata, created_at) VALUES(${toKey}, ${fromKey}, ${"index-of"}, ${metadataJson}, ${now})`,
      );
    }

    appendJournal(tx, {
      kind: "artifact.relationship.added",
      resource: fromKey,
      actor: origin.actor,
      fence: null,
      data: { type, to_key: toKey },
      tokenId: origin.tokenId,
      source: origin.source,
      sourceVersion: origin.sourceVersion,
    });
  });
}

export function listIndexEntries(
  db: BaseSQLiteDatabase<"sync", unknown, typeof schema>,
  indexKey: string,
): Array<{
  r2_key: string;
  resource: string | null;
  kind: string;
  sha256: string;
  bytes: number;
  fence: number | null;
  mime_type: string;
  produced_at: number;
  produced_by: string;
  expires_at: number | null;
  tombstoned: number;
  exists: boolean;
}> {
  const rows = db.all<{
    r2_key: string;
    resource: string | null;
    kind: string;
    sha256: string;
    bytes: number;
    fence: number | null;
    mime_type: string;
    produced_at: number;
    produced_by: string;
    expires_at: number | null;
    tombstoned: number;
  }>(
    sql`SELECT p.r2_key, p.resource, p.kind, p.sha256, p.bytes, p.fence, p.mime_type, p.produced_at, p.produced_by, p.expires_at, p.tombstoned
        FROM artifact_pointers p
        JOIN artifact_relationships r ON r.from_key = p.r2_key
        WHERE r.to_key = ${indexKey} AND r.type = 'entry-of'
        ORDER BY p.produced_at DESC`,
  );

  return rows.map((row) => ({
    ...row,
    exists: row.tombstoned !== 1,
  }));
}

export type OrphanBlob = {
  key: string;
  size: number;
  metadata: Record<string, string>;
  search_title?: string | null;
  search_body_text?: string | null;
};

export type ReconcileResult = {
  orphans_found: number;
  orphans_recovered: number;
  orphans_unrecoverable: number;
  details: Array<{
    key: string;
    status: "recovered" | "skipped" | "unrecoverable";
    reason?: string;
  }>;
};

/**
 * Pre-execution complexity validation for FTS5 queries.
 * Rejects queries likely to cause CPU-bound stalls in the DO.
 *
 * Rules:
 * 1. Length > 200 chars -> reject
 * 2. More than 10 uppercase boolean operators (AND/OR/NOT/NEAR) -> reject
 * 3. Prefix wildcard with < 3 chars before * -> reject
 *
 * Throws SearchQueryError on violation (reuses existing invalid-query 400 path).
 */
export function validateFtsQuery(q: string): void {
  // Rule 1: Length cap
  if (q.length > 200) {
    throw new SearchQueryError("Query exceeds 200 character limit");
  }

  // Rule 2: Boolean operator count
  const operators = q.match(/\b(AND|OR|NOT|NEAR)\b/g);
  if (operators && operators.length > 10) {
    throw new SearchQueryError(
      "Query contains too many boolean operators (max 10)",
    );
  }

  // Rule 3: Short prefix wildcard
  const prefixWildcards = q.matchAll(/\b(\w+)\*/g);
  for (const match of prefixWildcards) {
    if (match[1].length < 3) {
      throw new SearchQueryError(
        "Prefix wildcard requires at least 3 characters before '*'",
      );
    }
  }
}

/**
 * Full-text search across indexed artifacts using FTS5.
 *
 * FTS5 v0.1 query syntax contract:
 * - Single terms: "migration" (case-insensitive, unicode61 tokenizer)
 * - Phrase queries: '"hello world"' (exact phrase match)
 * - Prefix queries: "migrat*" (prefix expansion)
 * - Boolean: "migration AND sqlite", "migration OR postgres", "migration NOT drizzle"
 * - NEAR: "NEAR(migration sqlite, 5)" (proximity within 5 tokens)
 * - Column filters: NOT supported in v0.1 (deferred)
 *
 * Tokenizer: unicode61 (SQLite default) — case-insensitive, folds diacritics,
 * splits on whitespace and Unicode punctuation categories.
 *
 * Results are ordered by bm25 relevance (ascending bm25 score = most relevant first,
 * because SQLite FTS5 bm25() returns negative values).
 */
export function searchArtifacts(
  db: BaseSQLiteDatabase<"sync", unknown, typeof schema>,
  query: {
    q: string;
    kind?: string | string[];
    resource?: string;
    source_only?: boolean;
    limit?: number;
    tagFilter?: string[];
  },
): ArtifactSearchResult[] {
  validateFtsQuery(query.q);
  const limit = Math.min(query.limit ?? 20, 100);

  // Build dynamic WHERE conditions using Drizzle sql tagged templates
  const conditions: SQL[] = [
    sql`fts.artifact_search_docs_fts MATCH ${query.q}`,
    sql`d.tombstoned = 0`,
  ];

  if (query.kind) {
    if (Array.isArray(query.kind)) {
      const placeholders = query.kind.map((k) => sql`${k}`);
      conditions.push(
        sql`d.kind IN (${sql.join(placeholders, sql.raw(", "))})`,
      );
    } else {
      conditions.push(sql`d.kind = ${query.kind}`);
    }
  }

  // source_only takes precedence over resource filter when both present
  if (query.source_only) {
    conditions.push(sql`d.resource IS NULL`);
  } else if (query.resource) {
    conditions.push(sql`d.resource = ${query.resource}`);
  }

  if (query.tagFilter?.length) {
    conditions.push(
      ...tagExistsConditions(
        "artifact_tags",
        sql`jt.artifact_key = d.artifact_key`,
        query.tagFilter.map((t) => t.toLowerCase()),
      ),
    );
  }

  const whereClause = sql.join(conditions, sql.raw(" AND "));

  try {
    const rows = db.all<{
      r2_key: string;
      kind: string;
      resource: string | null;
      mime_type: string;
      produced_at: number;
      title: string | null;
      indexed_at: number;
      snippet: string | null;
    }>(sql`
      SELECT
        d.artifact_key AS r2_key,
        d.kind,
        d.resource,
        d.mime_type,
        ap.produced_at,
        d.title,
        d.indexed_at,
        snippet(artifact_search_docs_fts, 1, '<b>', '</b>', '...', 10) AS snippet
      FROM artifact_search_docs_fts fts
      JOIN artifact_search_docs d ON d.rowid = fts.rowid
      INNER JOIN artifact_pointers ap ON ap.r2_key = d.artifact_key
      WHERE ${whereClause}
      ORDER BY bm25(artifact_search_docs_fts)
      LIMIT ${limit}
    `);

    return rows;
  } catch (err: unknown) {
    if (err instanceof Error) {
      const msg = err.message;
      if (msg.includes("fts5:") || msg.includes("syntax error")) {
        console.warn("[search] FTS5 query error:", msg, "| query:", query.q);
        throw new SearchQueryError("Invalid search query syntax");
      }
    }
    throw err;
  }
}

/**
 * Searchable pointer row returned by listSearchablePointers.
 * NOTE: No Cloudflare Workers types — this is pure SQLite read, safe for ops-sqlite.
 */
export type SearchablePointerRow = {
  r2_key: string;
  resource: string | null;
  kind: string;
  sha256: string;
};

/**
 * Returns non-tombstoned artifact_pointers that have a corresponding
 * artifact_search_docs row (i.e. they were indexed for search).
 *
 * Used by the Worker's reconcile route to cross-check that each searchable
 * pointer still has an R2 blob. The R2 head() call is done by the Worker
 * (which has the R2 binding) — this helper is purely a SQLite read.
 *
 * Returns at most `limit` rows, ordered by r2_key for stable output.
 */
export function listSearchablePointers(
  db: BaseSQLiteDatabase<"sync", unknown, typeof schema>,
  limit: number,
): SearchablePointerRow[] {
  return db.all<SearchablePointerRow>(
    sql`SELECT ap.r2_key, ap.resource, ap.kind, ap.sha256
        FROM artifact_pointers ap
        INNER JOIN artifact_search_docs asd ON asd.artifact_key = ap.r2_key
        WHERE ap.tombstoned = 0 AND asd.tombstoned = 0
        ORDER BY ap.r2_key
        LIMIT ${limit}`,
  );
}

/**
 * Returns every r2_key in artifact_pointers — tombstoned records included, no limit.
 * Used by the project destroy flow to enumerate all blobs a project references so
 * reference-counted GC can decide which keys to delete.
 *
 * Ordered by r2_key (PK) for stable, reproducible output.
 */
export function listAllPointerKeys(
  db: BaseSQLiteDatabase<"sync", unknown, typeof schema>,
): string[] {
  const rows = db
    .select({ r2_key: schema.artifactPointers.r2_key })
    .from(schema.artifactPointers)
    .orderBy(schema.artifactPointers.r2_key)
    .all();
  return rows.map((r) => r.r2_key);
}

export function reconcilePointers(
  db: BaseSQLiteDatabase<"sync", unknown, typeof schema>,
  orphans: OrphanBlob[],
  origin: RequestOrigin,
  apply: boolean,
): ReconcileResult {
  const result: ReconcileResult = {
    orphans_found: orphans.length,
    orphans_recovered: 0,
    orphans_unrecoverable: 0,
    details: [],
  };

  for (const orphan of orphans) {
    const kind = orphan.metadata["tila-kind"];
    if (!kind) {
      result.orphans_unrecoverable++;
      result.details.push({
        key: orphan.key,
        status: "unrecoverable",
        reason: "missing tila-kind metadata",
      });
      continue;
    }

    if (!apply) {
      result.details.push({ key: orphan.key, status: "skipped" });
      continue;
    }

    // Recover: build pointer from R2 metadata
    const sha256 = orphan.metadata["tila-sha256"] ?? "";
    const mimeType = orphan.metadata["tila-mime"] ?? "application/octet-stream";
    const resource = orphan.metadata["tila-task"] || null;
    const fenceStr = orphan.metadata["tila-fence"];
    const fence = fenceStr ? Number.parseInt(fenceStr, 10) : null;

    try {
      const searchText =
        orphan.search_body_text != null
          ? {
              title: orphan.search_title ?? null,
              body_text: orphan.search_body_text,
            }
          : undefined;

      upsertPointer(
        db,
        {
          r2_key: orphan.key,
          resource: resource === "" ? null : resource,
          kind,
          sha256,
          bytes: orphan.size,
          fence: Number.isNaN(fence) ? null : fence,
          mime_type: mimeType,
          produced_at: Date.now(),
          produced_by: origin.actor,
          expires_at: null,
        },
        origin,
        "artifact.reconciled",
        searchText,
      );
      result.orphans_recovered++;
      result.details.push({ key: orphan.key, status: "recovered" });
    } catch (err) {
      result.orphans_unrecoverable++;
      result.details.push({
        key: orphan.key,
        status: "unrecoverable",
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}

// --- Search Rebuild ---

export type SearchRebuildCandidate = {
  artifact_key: string;
  kind: string;
  resource: string | null;
  sha256: string;
  mime_type: string;
  produced_at: number;
  pointer_tombstoned: number; // 0 or 1
  title: string | null;
  body_text: string | null;
  source_sha256: string | null;
};

export type SearchRebuildResult = {
  candidates_found: number;
  written: number;
  tombstoned: number;
  skipped: number;
  unrecoverable: number;
  details: Array<{
    artifact_key: string;
    status: "written" | "tombstoned" | "skipped" | "unrecoverable";
    reason?: string;
  }>;
};

export function rebuildSearchDocs(
  db: BaseSQLiteDatabase<"sync", unknown, typeof schema>,
  candidates: SearchRebuildCandidate[],
  origin: RequestOrigin,
  apply: boolean,
): SearchRebuildResult {
  const result: SearchRebuildResult = {
    candidates_found: candidates.length,
    written: 0,
    tombstoned: 0,
    skipped: 0,
    unrecoverable: 0,
    details: [],
  };

  for (const candidate of candidates) {
    // Check existing search doc state
    const existing = db.get<{
      artifact_key: string;
      source_sha256: string;
      tombstoned: number;
    }>(
      sql`SELECT artifact_key, source_sha256, tombstoned FROM artifact_search_docs WHERE artifact_key = ${candidate.artifact_key}`,
    );

    // Case 1: Pointer is tombstoned
    if (candidate.pointer_tombstoned === 1) {
      if (existing && existing.tombstoned === 0) {
        // Tombstone-leak fix: search doc is live but pointer is tombstoned
        if (!apply) {
          result.skipped++;
          result.details.push({
            artifact_key: candidate.artifact_key,
            status: "skipped",
            reason: "tombstone-leak (dry-run)",
          });
          continue;
        }
        db.transaction((tx) => {
          tx.run(
            sql`UPDATE artifact_search_docs SET tombstoned = 1 WHERE artifact_key = ${candidate.artifact_key}`,
          );
          appendJournal(tx, {
            kind: "artifact.search.rebuilt",
            resource: candidate.resource ?? candidate.artifact_key,
            actor: origin.actor,
            fence: null,
            tokenId: origin.tokenId,
            source: origin.source,
            sourceVersion: origin.sourceVersion,
          });
        });
        result.tombstoned++;
        result.details.push({
          artifact_key: candidate.artifact_key,
          status: "tombstoned",
        });
      } else {
        // No search doc or already tombstoned -- skip
        result.skipped++;
        result.details.push({
          artifact_key: candidate.artifact_key,
          status: "skipped",
          reason: existing
            ? "already tombstoned"
            : "tombstoned pointer, no search doc",
        });
      }
      continue;
    }

    // Case 2: Pointer is live, check if we can rebuild
    if (candidate.body_text === null && candidate.source_sha256 === null) {
      // No text content available -- unrecoverable
      result.unrecoverable++;
      result.details.push({
        artifact_key: candidate.artifact_key,
        status: "unrecoverable",
        reason: "body_text not available (R2 read failed or unsupported MIME)",
      });
      continue;
    }

    // Case 3: Existing search doc with matching sha256 -- already current
    if (existing && existing.source_sha256 === candidate.source_sha256) {
      result.skipped++;
      result.details.push({
        artifact_key: candidate.artifact_key,
        status: "skipped",
        reason: "already current",
      });
      continue;
    }

    // Case 4: Missing or stale -- write/update
    if (!apply) {
      result.skipped++;
      result.details.push({
        artifact_key: candidate.artifact_key,
        status: "skipped",
        reason: existing ? "stale (dry-run)" : "missing (dry-run)",
      });
      continue;
    }

    db.transaction((tx) => {
      tx.run(
        sql`INSERT OR REPLACE INTO artifact_search_docs (artifact_key, kind, mime_type, resource, title, body_text, indexed_at, source_sha256, tombstoned) VALUES (${candidate.artifact_key}, ${candidate.kind}, ${candidate.mime_type}, ${candidate.resource}, ${candidate.title ?? ""}, ${candidate.body_text ?? ""}, ${Date.now()}, ${candidate.source_sha256}, 0)`,
      );
      appendJournal(tx, {
        kind: "artifact.search.rebuilt",
        resource: candidate.resource ?? candidate.artifact_key,
        actor: origin.actor,
        fence: null,
        tokenId: origin.tokenId,
        source: origin.source,
        sourceVersion: origin.sourceVersion,
      });
    });
    result.written++;
    result.details.push({
      artifact_key: candidate.artifact_key,
      status: "written",
    });
  }

  return result;
}
