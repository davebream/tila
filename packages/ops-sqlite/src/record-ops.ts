import { assertFence } from "@tila/core";
import {
  type RecordDefinition,
  type RecordHistoryItem,
  type RecordListItem,
  type RecordRow,
  type RecordSearchResult,
  canonicalJson,
  canonicalJsonSha256,
  formatRecordResource,
} from "@tila/schemas";
import { type SQL, and, desc, eq, or, sql } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { SearchQueryError, validateFtsQuery } from "./artifact-ops";
import { type DoIdempotency, withDoIdempotency } from "./do-idempotency-ops";
import { assertResourceFence } from "./fence-ops";
import { type RequestOrigin, appendJournal } from "./journal-ops";
import * as schema from "./schema";
import { tagExistsConditions } from "./tag-filter-ops";

// ---------------------------------------------------------------------------
// Error classes
// ---------------------------------------------------------------------------

export class RecordAlreadyExistsError extends Error {
  constructor(
    public readonly type: string,
    public readonly key: string,
  ) {
    super(`Record ${type}/${key} already exists`);
    this.name = "RecordAlreadyExistsError";
  }
}

export class RecordNotFoundError extends Error {
  constructor(
    public readonly type: string,
    public readonly key: string,
  ) {
    super(`Record ${type}/${key} not found`);
    this.name = "RecordNotFoundError";
  }
}

export class RecordInvalidStateError extends Error {
  constructor(
    public readonly type: string,
    public readonly key: string,
    public readonly reason: string,
  ) {
    super(`Record ${type}/${key} invalid state: ${reason}`);
    this.name = "RecordInvalidStateError";
  }
}

export class RevisionNotFoundError extends Error {
  constructor(
    public readonly type: string,
    public readonly key: string,
    public readonly revision: number,
  ) {
    super(`Revision ${revision} for record ${type}/${key} not found`);
    this.name = "RevisionNotFoundError";
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// `RecordRow`, `RecordListItem`, and `RecordHistoryItem` are now defined
// canonically in `@tila/schemas` (see `RecordRowSchema` etc.) and re-exported
// here for backward compatibility with existing consumers of this module.
export type { RecordRow, RecordListItem, RecordHistoryItem };

// ---------------------------------------------------------------------------
// FTS5 text extraction helper
// ---------------------------------------------------------------------------

/**
 * Recursively flattens all string values from a JSON object and concatenates
 * them with newlines to form the FTS5 body_text for record search indexing.
 * Capped at 64 KiB (the record value limit).
 */
export function extractSearchText(value: Record<string, unknown>): string {
  const strings: string[] = [];

  function collect(v: unknown): void {
    if (typeof v === "string") {
      strings.push(v);
    } else if (Array.isArray(v)) {
      for (const item of v) {
        collect(item);
      }
    } else if (v !== null && typeof v === "object") {
      for (const val of Object.values(v as Record<string, unknown>)) {
        collect(val);
      }
    }
  }

  collect(value);
  const joined = strings.join("\n");
  // Cap at 64 KiB
  return joined.length > 65536 ? joined.slice(0, 65536) : joined;
}

// ---------------------------------------------------------------------------
// searchRecords — FTS5 full-text search across record_search_docs
// ---------------------------------------------------------------------------

/**
 * Full-text search across indexed records using FTS5.
 *
 * Returns results ordered by bm25 relevance (most relevant first).
 * Tombstoned (archived) records are excluded.
 */
export function searchRecords(
  db: BaseSQLiteDatabase<"sync", unknown, typeof schema>,
  query: {
    q: string;
    limit?: number;
    tagFilter?: string[];
    /** Internal: skip validation when the caller (searchAll) has already validated. */
    _skipValidation?: boolean;
  },
): RecordSearchResult[] {
  if (!query._skipValidation) validateFtsQuery(query.q);
  const limit = Math.min(query.limit ?? 20, 100);

  const tagConditions = query.tagFilter?.length
    ? tagExistsConditions(
        "record_tags",
        sql`jt.type = d.record_type AND jt.key = d.record_key`,
        query.tagFilter.map((t) => t.toLowerCase()),
      )
    : [];

  try {
    const rows = db.all<{
      record_type: string;
      record_key: string;
      indexed_at: number;
      snippet: string | null;
    }>(sql`
      SELECT
        d.record_type,
        d.record_key,
        d.indexed_at,
        snippet(record_search_docs_fts, 0, '<b>', '</b>', '...', 10) AS snippet
      FROM record_search_docs_fts fts
      JOIN record_search_docs d ON d.rowid = fts.rowid
      WHERE record_search_docs_fts MATCH ${query.q}
        AND d.tombstoned = 0
        ${tagConditions.length ? sql`AND ${sql.join(tagConditions, sql.raw(" AND "))}` : sql``}
      ORDER BY bm25(record_search_docs_fts)
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

// ---------------------------------------------------------------------------
// RFC 7396 JSON Merge Patch (module-private)
// ---------------------------------------------------------------------------

function mergePatch(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete result[key];
    } else if (
      typeof value === "object" &&
      !Array.isArray(value) &&
      typeof result[key] === "object" &&
      result[key] !== null &&
      !Array.isArray(result[key])
    ) {
      result[key] = mergePatch(
        result[key] as Record<string, unknown>,
        value as Record<string, unknown>,
      );
    } else {
      result[key] = value;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Value validation (called by DO router before delegating to ops functions)
// ---------------------------------------------------------------------------

/**
 * Validates a record value against its declared RecordDefinition fields.
 * Checks required fields are present. Does NOT check the 64 KiB limit here —
 * that is enforced by RecordValueSchema at the API boundary.
 */
export function validateRecordValue(
  value: Record<string, unknown>,
  recordDef: RecordDefinition,
): { ok: true } | { ok: false; errors: string[] } {
  const fields = recordDef.fields ?? {};
  const errors: string[] = [];

  for (const [fieldName, decl] of Object.entries(fields)) {
    if (decl.required && !(fieldName in value)) {
      errors.push(`Required field "${fieldName}" is missing`);
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Shared write helpers — reused by createRecord / setRecord / putRecord.
// All operate on an open transaction handle (`tx`) and are synchronous, so
// callers can invoke them inside `db.transaction((tx) => {…})` with no `await`
// in the transaction body (atomicity invariant; see putRecord/setRecord).
// ---------------------------------------------------------------------------

type RecordWriteTx = Parameters<
  Parameters<
    BaseSQLiteDatabase<"sync", unknown, typeof schema>["transaction"]
  >[0]
>[0];

/** Bump the resource fence (insert-or-increment) and return the new value. */
function bumpFence(tx: RecordWriteTx, resource: string): number {
  tx.run(
    sql`INSERT INTO fences(resource, current_fence) VALUES(${resource}, 1) ON CONFLICT(resource) DO UPDATE SET current_fence = current_fence + 1`,
  );
  const fenceRow = tx
    .select()
    .from(schema.fences)
    .where(eq(schema.fences.resource, resource))
    .get();
  return fenceRow?.current_fence ?? 1;
}

/** Insert a record_revisions row. */
function insertRevisionRow(
  tx: RecordWriteTx,
  args: {
    type: string;
    key: string;
    revision: number;
    operation: string;
    schema_version: number;
    value_json: string;
    value_sha256: string;
    canonical_artifact_key?: string | null;
    source_artifact_key?: string | null;
    actor: string;
    created_at: number;
    message?: string | null;
    origin: RequestOrigin;
  },
): void {
  tx.insert(schema.recordRevisions)
    .values({
      type: args.type,
      key: args.key,
      revision: args.revision,
      operation: args.operation,
      schema_version: args.schema_version,
      value_json: args.value_json,
      value_sha256: args.value_sha256,
      canonical_artifact_key: args.canonical_artifact_key ?? null,
      source_artifact_key: args.source_artifact_key ?? null,
      actor: args.actor,
      created_at: args.created_at,
      message: args.message ?? null,
      token_id: args.origin.tokenId ?? null,
      source: args.origin.source ?? null,
      source_version: args.origin.sourceVersion ?? null,
    })
    .run();
}

/**
 * Replace the tag set for a record with `tags` (delete-then-insert).
 * Used when an explicit tag set is provided.
 */
function replaceTags(
  tx: RecordWriteTx,
  type: string,
  key: string,
  tags: string[],
): void {
  tx.delete(schema.recordTags)
    .where(
      and(eq(schema.recordTags.type, type), eq(schema.recordTags.key, key)),
    )
    .run();
  for (const tag of tags) {
    tx.insert(schema.recordTags).values({ type, key, tag }).run();
  }
}

/** Read the current tag list for a record. */
function readTags(tx: RecordWriteTx, type: string, key: string): string[] {
  return tx
    .select()
    .from(schema.recordTags)
    .where(
      and(eq(schema.recordTags.type, type), eq(schema.recordTags.key, key)),
    )
    .all()
    .map((r) => r.tag);
}

/**
 * Write the FTS search doc for a record, skipping the rewrite when the stored
 * sha256 is unchanged (idempotent-resave guard). `tombstoned` controls search
 * visibility — pass `existing.archived` to preserve lifecycle on replace.
 */
function writeSearchDoc(
  tx: RecordWriteTx,
  args: {
    type: string;
    key: string;
    bodyText: string;
    sha256: string;
    tombstoned: number;
  },
): void {
  const existingSearchDoc = tx.get<{ value_sha256: string }>(
    sql`SELECT value_sha256 FROM record_search_docs WHERE record_type = ${args.type} AND record_key = ${args.key}`,
  );
  if (existingSearchDoc && existingSearchDoc.value_sha256 === args.sha256) {
    return;
  }
  const indexedAt = Date.now();
  tx.run(
    sql`INSERT OR REPLACE INTO record_search_docs(record_type, record_key, body_text, indexed_at, value_sha256, tombstoned) VALUES(${args.type}, ${args.key}, ${args.bodyText}, ${indexedAt}, ${args.sha256}, ${args.tombstoned})`,
  );
}

// ---------------------------------------------------------------------------
// createRecord — fenceless, first-writer-wins
// ---------------------------------------------------------------------------

export async function createRecord(
  db: BaseSQLiteDatabase<"sync", unknown, typeof schema>,
  input: {
    type: string;
    key: string;
    value: Record<string, unknown>;
    tags?: string[];
    message?: string | null;
    source_artifact_key?: string | null;
    canonical_artifact_key?: string | null;
    schema_version: number;
    actor: string;
  },
  origin: RequestOrigin,
): Promise<RecordRow> {
  const canonical = canonicalJson(input.value);
  const sha256 = await canonicalJsonSha256(input.value);
  const now = Date.now();
  const resource = formatRecordResource(input.type, input.key);
  const tags = input.tags ?? [];
  // Extract search text BEFORE transaction to avoid holding lock during string ops
  const bodyText = extractSearchText(input.value);

  return db.transaction((tx) => {
    // Insert record — PK conflict throws UNIQUE constraint error
    try {
      tx.insert(schema.records)
        .values({
          type: input.type,
          key: input.key,
          schema_version: input.schema_version,
          value_json: canonical,
          value_sha256: sha256,
          revision: 1,
          archived: 0,
          created_at: now,
          updated_at: now,
          updated_by: input.actor,
        })
        .run();
    } catch (err: unknown) {
      if (
        err instanceof Error &&
        err.message.includes("UNIQUE constraint failed")
      ) {
        throw new RecordAlreadyExistsError(input.type, input.key);
      }
      throw err;
    }

    // Upsert fence
    const fence = bumpFence(tx, resource);

    // Insert revision row
    insertRevisionRow(tx, {
      type: input.type,
      key: input.key,
      revision: 1,
      operation: "created",
      schema_version: input.schema_version,
      value_json: canonical,
      value_sha256: sha256,
      canonical_artifact_key: input.canonical_artifact_key,
      source_artifact_key: input.source_artifact_key,
      actor: input.actor,
      created_at: now,
      message: input.message,
      origin,
    });

    // Insert tags
    for (const tag of tags) {
      tx.insert(schema.recordTags)
        .values({
          type: input.type,
          key: input.key,
          tag,
        })
        .run();
    }

    // Journal event
    appendJournal(tx, {
      kind: "record.created",
      resource,
      actor: input.actor,
      fence,
      tokenId: origin.tokenId,
      source: origin.source,
      sourceVersion: origin.sourceVersion,
    });

    // Index into record_search_docs (FTS5 trigger fires automatically)
    writeSearchDoc(tx, {
      type: input.type,
      key: input.key,
      bodyText,
      sha256,
      tombstoned: 0,
    });

    return {
      type: input.type,
      key: input.key,
      schema_version: input.schema_version,
      value: input.value,
      value_sha256: sha256,
      revision: 1,
      archived: 0,
      created_at: now,
      updated_at: now,
      updated_by: input.actor,
      tags,
      fence,
    };
  });
}

// ---------------------------------------------------------------------------
// setRecord — fence-required, full replace
// ---------------------------------------------------------------------------

export async function setRecord(
  db: BaseSQLiteDatabase<"sync", unknown, typeof schema>,
  input: {
    type: string;
    key: string;
    value: Record<string, unknown>;
    fence: number;
    tags?: string[];
    message?: string | null;
    source_artifact_key?: string | null;
    canonical_artifact_key?: string | null;
    schema_version: number;
    actor: string;
  },
  origin: RequestOrigin,
  idempotency?: DoIdempotency<RecordRow>,
): Promise<RecordRow> {
  const canonical = canonicalJson(input.value);
  const sha256 = await canonicalJsonSha256(input.value);
  const now = Date.now();
  const resource = formatRecordResource(input.type, input.key);
  // Extract search text BEFORE transaction to avoid holding lock during string ops
  const bodyText = extractSearchText(input.value);

  return db.transaction((tx) => {
    // Dedup the fence-mutating set inside this transaction (audit B1): a replay
    // returns the stored revision/fence without bumping the fence again.
    return withDoIdempotency(tx, idempotency, () => doSet()).result;

    function doSet(): RecordRow {
      // Read existing record
      const existing = tx
        .select()
        .from(schema.records)
        .where(
          and(
            eq(schema.records.type, input.type),
            eq(schema.records.key, input.key),
          ),
        )
        .get();

      if (!existing) {
        throw new RecordNotFoundError(input.type, input.key);
      }

      // Validate fence
      assertResourceFence(tx, resource, input.fence);

      const newRevision = existing.revision + 1;

      // Update record
      tx.update(schema.records)
        .set({
          schema_version: input.schema_version,
          value_json: canonical,
          value_sha256: sha256,
          revision: newRevision,
          updated_at: now,
          updated_by: input.actor,
        })
        .where(
          and(
            eq(schema.records.type, input.type),
            eq(schema.records.key, input.key),
          ),
        )
        .run();

      // Increment fence
      const newFence = bumpFence(tx, resource);

      // Insert revision row
      insertRevisionRow(tx, {
        type: input.type,
        key: input.key,
        revision: newRevision,
        operation: "set",
        schema_version: input.schema_version,
        value_json: canonical,
        value_sha256: sha256,
        canonical_artifact_key: input.canonical_artifact_key,
        source_artifact_key: input.source_artifact_key,
        actor: input.actor,
        created_at: now,
        message: input.message,
        origin,
      });

      // Replace tags (if provided)
      if (input.tags !== undefined) {
        replaceTags(tx, input.type, input.key, input.tags);
      }

      // Determine final tags for return value
      const finalTags =
        input.tags !== undefined
          ? input.tags
          : readTags(tx, input.type, input.key);

      // Journal event
      appendJournal(tx, {
        kind: "record.updated",
        resource,
        actor: input.actor,
        fence: newFence,
        tokenId: origin.tokenId,
        source: origin.source,
        sourceVersion: origin.sourceVersion,
      });

      // Update record_search_docs (sha256 guard to skip unchanged content).
      // NOTE: setRecord unconditionally writes tombstoned=0 — this is the
      // pre-existing archived-resurrection inconsistency (record-ops.ts) that
      // putRecord deliberately does NOT inherit (it preserves existing.archived).
      writeSearchDoc(tx, {
        type: input.type,
        key: input.key,
        bodyText,
        sha256,
        tombstoned: 0,
      });

      return {
        type: input.type,
        key: input.key,
        schema_version: input.schema_version,
        value: input.value,
        value_sha256: sha256,
        revision: newRevision,
        archived: existing.archived,
        created_at: existing.created_at,
        updated_at: now,
        updated_by: input.actor,
        tags: finalTags,
        fence: newFence,
      };
    }
  });
}

// ---------------------------------------------------------------------------
// putRecord — fenceless create-or-replace (upsert), single-writer canonical
// ---------------------------------------------------------------------------

export async function putRecord(
  db: BaseSQLiteDatabase<"sync", unknown, typeof schema>,
  input: {
    type: string;
    key: string;
    value: Record<string, unknown>;
    tags?: string[];
    message?: string | null;
    source_artifact_key?: string | null;
    canonical_artifact_key?: string | null;
    schema_version: number;
    actor: string;
  },
  origin: RequestOrigin,
): Promise<RecordRow> {
  // Compute canonical form + sha256 BEFORE the transaction — they do not depend
  // on `existing`, so hoisting them keeps the txn body free of `await` (RC-1).
  const canonical = canonicalJson(input.value);
  const sha256 = await canonicalJsonSha256(input.value);
  const now = Date.now();
  const resource = formatRecordResource(input.type, input.key);
  // Extract search text BEFORE transaction to avoid holding lock during string ops
  const bodyText = extractSearchText(input.value);

  return db.transaction((tx) => {
    // Read existing row INSIDE the transaction — this is the create/replace
    // discriminator AND the basis for `existing.revision + 1`. Both MUST be
    // read in-txn for atomicity (mirror setRecord, NOT patchRecord). No `await`
    // anywhere in this callback. (RC-1, binding.)
    const existing = tx
      .select()
      .from(schema.records)
      .where(
        and(
          eq(schema.records.type, input.type),
          eq(schema.records.key, input.key),
        ),
      )
      .get();

    if (!existing) {
      // ---- Create branch ----
      tx.insert(schema.records)
        .values({
          type: input.type,
          key: input.key,
          schema_version: input.schema_version,
          value_json: canonical,
          value_sha256: sha256,
          revision: 1,
          archived: 0,
          created_at: now,
          updated_at: now,
          updated_by: input.actor,
        })
        .run();

      const fence = bumpFence(tx, resource);

      insertRevisionRow(tx, {
        type: input.type,
        key: input.key,
        revision: 1,
        operation: "created",
        schema_version: input.schema_version,
        value_json: canonical,
        value_sha256: sha256,
        canonical_artifact_key: input.canonical_artifact_key,
        source_artifact_key: input.source_artifact_key,
        actor: input.actor,
        created_at: now,
        message: input.message,
        origin,
      });

      const tags = input.tags ?? [];
      for (const tag of tags) {
        tx.insert(schema.recordTags)
          .values({ type: input.type, key: input.key, tag })
          .run();
      }

      appendJournal(tx, {
        kind: "record.created",
        resource,
        actor: input.actor,
        fence,
        tokenId: origin.tokenId,
        source: origin.source,
        sourceVersion: origin.sourceVersion,
      });

      writeSearchDoc(tx, {
        type: input.type,
        key: input.key,
        bodyText,
        sha256,
        tombstoned: 0,
      });

      return {
        type: input.type,
        key: input.key,
        schema_version: input.schema_version,
        value: input.value,
        value_sha256: sha256,
        revision: 1,
        archived: 0,
        created_at: now,
        updated_at: now,
        updated_by: input.actor,
        tags,
        fence,
      };
    }

    // ---- Replace branch ----
    const newRevision = existing.revision + 1;

    tx.update(schema.records)
      .set({
        schema_version: input.schema_version,
        value_json: canonical,
        value_sha256: sha256,
        revision: newRevision,
        updated_at: now,
        updated_by: input.actor,
      })
      .where(
        and(
          eq(schema.records.type, input.type),
          eq(schema.records.key, input.key),
        ),
      )
      .run();

    const newFence = bumpFence(tx, resource);

    insertRevisionRow(tx, {
      type: input.type,
      key: input.key,
      revision: newRevision,
      operation: "set",
      schema_version: input.schema_version,
      value_json: canonical,
      value_sha256: sha256,
      canonical_artifact_key: input.canonical_artifact_key,
      source_artifact_key: input.source_artifact_key,
      actor: input.actor,
      created_at: now,
      message: input.message,
      origin,
    });

    if (input.tags !== undefined) {
      replaceTags(tx, input.type, input.key, input.tags);
    }
    const finalTags =
      input.tags !== undefined
        ? input.tags
        : readTags(tx, input.type, input.key);

    appendJournal(tx, {
      kind: "record.updated",
      resource,
      actor: input.actor,
      fence: newFence,
      tokenId: origin.tokenId,
      source: origin.source,
      sourceVersion: origin.sourceVersion,
    });

    // Preserve search-visibility lifecycle: tombstoned = existing.archived.
    // A fenceless put must NEVER resurrect an archived record into search —
    // this is the deliberate divergence from setRecord (which writes
    // tombstoned=0 unconditionally). Preserves the sha256-skip guard.
    writeSearchDoc(tx, {
      type: input.type,
      key: input.key,
      bodyText,
      sha256,
      tombstoned: existing.archived,
    });

    return {
      type: input.type,
      key: input.key,
      schema_version: input.schema_version,
      value: input.value,
      value_sha256: sha256,
      revision: newRevision,
      archived: existing.archived,
      created_at: existing.created_at,
      updated_at: now,
      updated_by: input.actor,
      tags: finalTags,
      fence: newFence,
    };
  });
}

// ---------------------------------------------------------------------------
// getRecord — read with tags and fence
// ---------------------------------------------------------------------------

export function getRecord(
  db: BaseSQLiteDatabase<"sync", unknown, typeof schema>,
  type: string,
  key: string,
): RecordRow | null {
  const row = db
    .select()
    .from(schema.records)
    .where(and(eq(schema.records.type, type), eq(schema.records.key, key)))
    .get();

  if (!row) return null;

  const resource = formatRecordResource(type, key);

  const tags = db
    .select()
    .from(schema.recordTags)
    .where(
      and(eq(schema.recordTags.type, type), eq(schema.recordTags.key, key)),
    )
    .all()
    .map((r) => r.tag);

  const fenceRow = db
    .select()
    .from(schema.fences)
    .where(eq(schema.fences.resource, resource))
    .get();
  const fence = fenceRow?.current_fence ?? 0;

  return {
    type: row.type,
    key: row.key,
    schema_version: row.schema_version,
    value: JSON.parse(row.value_json) as Record<string, unknown>,
    value_sha256: row.value_sha256,
    revision: row.revision,
    archived: row.archived,
    created_at: row.created_at,
    updated_at: row.updated_at,
    updated_by: row.updated_by,
    tags,
    fence,
  };
}

// ---------------------------------------------------------------------------
// patchRecord — fence-required, RFC 7396 merge patch
// ---------------------------------------------------------------------------

export async function patchRecord(
  db: BaseSQLiteDatabase<"sync", unknown, typeof schema>,
  input: {
    type: string;
    key: string;
    patch: Record<string, unknown>;
    fence: number;
    message?: string | null;
    schema_version: number;
    actor: string;
  },
  origin: RequestOrigin,
  idempotency?: DoIdempotency<RecordRow>,
): Promise<RecordRow> {
  // Pre-read current value outside transaction for SHA-256 computation
  const preRead = db
    .select()
    .from(schema.records)
    .where(
      and(
        eq(schema.records.type, input.type),
        eq(schema.records.key, input.key),
      ),
    )
    .get();

  if (!preRead) throw new RecordNotFoundError(input.type, input.key);
  if (preRead.archived === 1) {
    throw new RecordInvalidStateError(
      input.type,
      input.key,
      "cannot patch archived record",
    );
  }

  const currentValue = JSON.parse(preRead.value_json) as Record<
    string,
    unknown
  >;
  const merged = mergePatch(currentValue, input.patch);
  const canonical = canonicalJson(merged);
  const sha256 = await canonicalJsonSha256(merged);
  const now = Date.now();
  const resource = formatRecordResource(input.type, input.key);
  // Extract search text BEFORE transaction to avoid holding lock during string ops
  const bodyText = extractSearchText(merged);

  return db.transaction((tx) => {
    // Dedup the fence-mutating patch inside this transaction (audit B1).
    return withDoIdempotency(tx, idempotency, () => doPatch()).result;

    function doPatch(): RecordRow {
      // Re-read inside transaction (authoritative state check)
      const existing = tx
        .select()
        .from(schema.records)
        .where(
          and(
            eq(schema.records.type, input.type),
            eq(schema.records.key, input.key),
          ),
        )
        .get();
      if (!existing) throw new RecordNotFoundError(input.type, input.key);
      if (existing.archived === 1) {
        throw new RecordInvalidStateError(
          input.type,
          input.key,
          "cannot patch archived record",
        );
      }

      // Fence check
      assertResourceFence(tx, resource, input.fence);

      const newRevision = existing.revision + 1;

      // Update record
      tx.update(schema.records)
        .set({
          schema_version: input.schema_version,
          value_json: canonical,
          value_sha256: sha256,
          revision: newRevision,
          updated_at: now,
          updated_by: input.actor,
        })
        .where(
          and(
            eq(schema.records.type, input.type),
            eq(schema.records.key, input.key),
          ),
        )
        .run();

      // Increment fence
      tx.run(
        sql`INSERT INTO fences(resource, current_fence) VALUES(${resource}, 1) ON CONFLICT(resource) DO UPDATE SET current_fence = current_fence + 1`,
      );
      const newFenceRow = tx
        .select()
        .from(schema.fences)
        .where(eq(schema.fences.resource, resource))
        .get();
      const newFence = newFenceRow?.current_fence ?? 1;

      // Revision row
      tx.insert(schema.recordRevisions)
        .values({
          type: input.type,
          key: input.key,
          revision: newRevision,
          operation: "patch",
          schema_version: input.schema_version,
          value_json: canonical,
          value_sha256: sha256,
          canonical_artifact_key: null,
          source_artifact_key: null,
          actor: input.actor,
          created_at: now,
          message: input.message ?? null,
          token_id: origin.tokenId ?? null,
          source: origin.source ?? null,
          source_version: origin.sourceVersion ?? null,
        })
        .run();

      // Tags unchanged by patch -- read current tags for return value
      const tags = tx
        .select()
        .from(schema.recordTags)
        .where(
          and(
            eq(schema.recordTags.type, input.type),
            eq(schema.recordTags.key, input.key),
          ),
        )
        .all()
        .map((r) => r.tag);

      appendJournal(tx, {
        kind: "record.updated",
        resource,
        actor: input.actor,
        fence: newFence,
        tokenId: origin.tokenId,
        source: origin.source,
        sourceVersion: origin.sourceVersion,
      });

      // Update record_search_docs (sha256 guard to skip unchanged content)
      const existingSearchDoc = tx.get<{ value_sha256: string }>(
        sql`SELECT value_sha256 FROM record_search_docs WHERE record_type = ${input.type} AND record_key = ${input.key}`,
      );
      if (!existingSearchDoc || existingSearchDoc.value_sha256 !== sha256) {
        const indexedAt = Date.now();
        tx.run(
          sql`INSERT OR REPLACE INTO record_search_docs(record_type, record_key, body_text, indexed_at, value_sha256, tombstoned) VALUES(${input.type}, ${input.key}, ${bodyText}, ${indexedAt}, ${sha256}, 0)`,
        );
      }

      return {
        type: input.type,
        key: input.key,
        schema_version: input.schema_version,
        value: merged,
        value_sha256: sha256,
        revision: newRevision,
        archived: existing.archived,
        created_at: existing.created_at,
        updated_at: now,
        updated_by: input.actor,
        tags,
        fence: newFence,
      };
    }
  });
}

// ---------------------------------------------------------------------------
// archiveRecord — fence-required, sets archived=1
// ---------------------------------------------------------------------------

export function archiveRecord(
  db: BaseSQLiteDatabase<"sync", unknown, typeof schema>,
  input: {
    type: string;
    key: string;
    fence: number;
    message?: string | null;
    schema_version: number;
    actor: string;
  },
  origin: RequestOrigin,
  idempotency?: DoIdempotency<RecordRow>,
): RecordRow {
  const resource = formatRecordResource(input.type, input.key);
  const now = Date.now();

  return db.transaction((tx) => {
    // Dedup the fence-mutating archive inside this transaction (audit B1).
    return withDoIdempotency(tx, idempotency, () => doArchive()).result;

    function doArchive(): RecordRow {
      const existing = tx
        .select()
        .from(schema.records)
        .where(
          and(
            eq(schema.records.type, input.type),
            eq(schema.records.key, input.key),
          ),
        )
        .get();
      if (!existing) throw new RecordNotFoundError(input.type, input.key);
      if (existing.archived === 1) {
        throw new RecordInvalidStateError(
          input.type,
          input.key,
          "already archived",
        );
      }

      // Fence check
      assertResourceFence(tx, resource, input.fence);

      const newRevision = existing.revision + 1;

      tx.update(schema.records)
        .set({
          archived: 1,
          revision: newRevision,
          updated_at: now,
          updated_by: input.actor,
        })
        .where(
          and(
            eq(schema.records.type, input.type),
            eq(schema.records.key, input.key),
          ),
        )
        .run();

      // Increment fence
      tx.run(
        sql`INSERT INTO fences(resource, current_fence) VALUES(${resource}, 1) ON CONFLICT(resource) DO UPDATE SET current_fence = current_fence + 1`,
      );
      const newFenceRow = tx
        .select()
        .from(schema.fences)
        .where(eq(schema.fences.resource, resource))
        .get();
      const newFence = newFenceRow?.current_fence ?? 1;

      // Revision row (value copied verbatim from existing record)
      tx.insert(schema.recordRevisions)
        .values({
          type: input.type,
          key: input.key,
          revision: newRevision,
          operation: "archived",
          schema_version: existing.schema_version,
          value_json: existing.value_json,
          value_sha256: existing.value_sha256,
          canonical_artifact_key: null,
          source_artifact_key: null,
          actor: input.actor,
          created_at: now,
          message: input.message ?? null,
          token_id: origin.tokenId ?? null,
          source: origin.source ?? null,
          source_version: origin.sourceVersion ?? null,
        })
        .run();

      const tags = tx
        .select()
        .from(schema.recordTags)
        .where(
          and(
            eq(schema.recordTags.type, input.type),
            eq(schema.recordTags.key, input.key),
          ),
        )
        .all()
        .map((r) => r.tag);

      appendJournal(tx, {
        kind: "record.archived",
        resource,
        actor: input.actor,
        fence: newFence,
        tokenId: origin.tokenId,
        source: origin.source,
        sourceVersion: origin.sourceVersion,
      });

      // Tombstone the search doc so it won't appear in search results
      tx.run(
        sql`UPDATE record_search_docs SET tombstoned = 1 WHERE record_type = ${input.type} AND record_key = ${input.key}`,
      );

      return {
        type: input.type,
        key: input.key,
        schema_version: existing.schema_version,
        value: JSON.parse(existing.value_json) as Record<string, unknown>,
        value_sha256: existing.value_sha256,
        revision: newRevision,
        archived: 1,
        created_at: existing.created_at,
        updated_at: now,
        updated_by: input.actor,
        tags,
        fence: newFence,
      };
    }
  });
}

// ---------------------------------------------------------------------------
// unarchiveRecord — fence-required, sets archived=0
// ---------------------------------------------------------------------------

export function unarchiveRecord(
  db: BaseSQLiteDatabase<"sync", unknown, typeof schema>,
  input: {
    type: string;
    key: string;
    fence: number;
    message?: string | null;
    schema_version: number;
    actor: string;
  },
  origin: RequestOrigin,
  idempotency?: DoIdempotency<RecordRow>,
): RecordRow {
  const resource = formatRecordResource(input.type, input.key);
  const now = Date.now();

  return db.transaction((tx) => {
    // Dedup the fence-mutating unarchive inside this transaction (audit B1).
    return withDoIdempotency(tx, idempotency, () => doUnarchive()).result;

    function doUnarchive(): RecordRow {
      const existing = tx
        .select()
        .from(schema.records)
        .where(
          and(
            eq(schema.records.type, input.type),
            eq(schema.records.key, input.key),
          ),
        )
        .get();
      if (!existing) throw new RecordNotFoundError(input.type, input.key);
      if (existing.archived === 0) {
        throw new RecordInvalidStateError(
          input.type,
          input.key,
          "not archived",
        );
      }

      // Fence check
      assertResourceFence(tx, resource, input.fence);

      const newRevision = existing.revision + 1;

      tx.update(schema.records)
        .set({
          archived: 0,
          revision: newRevision,
          updated_at: now,
          updated_by: input.actor,
        })
        .where(
          and(
            eq(schema.records.type, input.type),
            eq(schema.records.key, input.key),
          ),
        )
        .run();

      // Increment fence
      tx.run(
        sql`INSERT INTO fences(resource, current_fence) VALUES(${resource}, 1) ON CONFLICT(resource) DO UPDATE SET current_fence = current_fence + 1`,
      );
      const newFenceRow = tx
        .select()
        .from(schema.fences)
        .where(eq(schema.fences.resource, resource))
        .get();
      const newFence = newFenceRow?.current_fence ?? 1;

      // Revision row (value copied verbatim from existing record)
      tx.insert(schema.recordRevisions)
        .values({
          type: input.type,
          key: input.key,
          revision: newRevision,
          operation: "unarchived",
          schema_version: existing.schema_version,
          value_json: existing.value_json,
          value_sha256: existing.value_sha256,
          canonical_artifact_key: null,
          source_artifact_key: null,
          actor: input.actor,
          created_at: now,
          message: input.message ?? null,
          token_id: origin.tokenId ?? null,
          source: origin.source ?? null,
          source_version: origin.sourceVersion ?? null,
        })
        .run();

      const tags = tx
        .select()
        .from(schema.recordTags)
        .where(
          and(
            eq(schema.recordTags.type, input.type),
            eq(schema.recordTags.key, input.key),
          ),
        )
        .all()
        .map((r) => r.tag);

      appendJournal(tx, {
        kind: "record.unarchived",
        resource,
        actor: input.actor,
        fence: newFence,
        tokenId: origin.tokenId,
        source: origin.source,
        sourceVersion: origin.sourceVersion,
      });

      // Restore search doc visibility after unarchive
      tx.run(
        sql`UPDATE record_search_docs SET tombstoned = 0 WHERE record_type = ${input.type} AND record_key = ${input.key}`,
      );

      return {
        type: input.type,
        key: input.key,
        schema_version: existing.schema_version,
        value: JSON.parse(existing.value_json) as Record<string, unknown>,
        value_sha256: existing.value_sha256,
        revision: newRevision,
        archived: 0,
        created_at: existing.created_at,
        updated_at: now,
        updated_by: input.actor,
        tags,
        fence: newFence,
      };
    }
  });
}

// ---------------------------------------------------------------------------
// listRecords — type-required, metadata-only, pagination envelope
// ---------------------------------------------------------------------------

export function listRecords(
  db: BaseSQLiteDatabase<"sync", unknown, typeof schema>,
  filter: {
    type: string;
    includeArchived?: boolean;
    tag?: string;
    tagFilter?: string[];
    dataFilter?: Record<string, unknown>;
    limit?: number;
  },
): { items: RecordListItem[]; total: number; next_cursor: string | null } {
  const effectiveLimit = Math.min(Math.max(filter.limit ?? 200, 1), 200);

  // Validate dataFilter: only scalar values allowed
  if (filter.dataFilter) {
    for (const [key, value] of Object.entries(filter.dataFilter)) {
      if (typeof value === "object" && value !== null) {
        throw new Error(
          `dataFilter values must be scalar (string, number, boolean, null). Key "${key}" has type ${Array.isArray(value) ? "array" : "object"}`,
        );
      }
    }
  }

  const conditions: SQL[] = [eq(schema.records.type, filter.type)];

  if (!filter.includeArchived) {
    conditions.push(eq(schema.records.archived, 0));
  }

  if (filter.tag) {
    conditions.push(
      sql`EXISTS (SELECT 1 FROM record_tags rt WHERE rt.type = ${schema.records.type} AND rt.key = ${schema.records.key} AND rt.tag = ${filter.tag})`,
    );
  }
  if (filter.tagFilter?.length) {
    const normalizedTags = filter.tagFilter.map((t) => t.toLowerCase());
    conditions.push(
      ...tagExistsConditions(
        "record_tags",
        sql`jt.type = ${schema.records.type} AND jt.key = ${schema.records.key}`,
        normalizedTags,
      ),
    );
  }

  if (filter.dataFilter) {
    for (const [key, value] of Object.entries(filter.dataFilter)) {
      conditions.push(
        sql`json_extract(${schema.records.value_json}, ${`$.${key}`}) = ${value}`,
      );
    }
  }

  const whereClause = and(...conditions);

  // COUNT(*) for total
  const countResult = db
    .select({ count: sql<number>`count(*)` })
    .from(schema.records)
    .where(whereClause)
    .get();
  const total = countResult?.count ?? 0;

  // Data query with LIMIT+1 probe
  const rows = db
    .select()
    .from(schema.records)
    .where(whereClause)
    .limit(effectiveLimit + 1)
    .all();

  const truncated = rows.length > effectiveLimit;
  const resultRows = truncated ? rows.slice(0, effectiveLimit) : rows;
  const next_cursor = truncated ? "truncated" : null;

  // Batch tag enrichment: single query for all returned records
  const items: RecordListItem[] = [];
  if (resultRows.length > 0) {
    const tagConditions = resultRows.map((r) =>
      and(eq(schema.recordTags.type, r.type), eq(schema.recordTags.key, r.key)),
    );
    const allTags = db
      .select()
      .from(schema.recordTags)
      .where(or(...(tagConditions as [SQL, ...SQL[]])))
      .all();

    // Build tag map: "type|key" -> tags[]
    const tagMap = new Map<string, string[]>();
    for (const t of allTags) {
      const mapKey = `${t.type}|${t.key}`;
      const arr = tagMap.get(mapKey) ?? [];
      arr.push(t.tag);
      tagMap.set(mapKey, arr);
    }

    for (const r of resultRows) {
      items.push({
        type: r.type,
        key: r.key,
        revision: r.revision,
        updated_at: r.updated_at,
        updated_by: r.updated_by,
        archived: r.archived,
        tags: tagMap.get(`${r.type}|${r.key}`) ?? [],
      });
    }
  }

  return { items, total, next_cursor };
}

// ---------------------------------------------------------------------------
// listRecordHistory — newest-first, optional values
// ---------------------------------------------------------------------------

export function listRecordHistory(
  db: BaseSQLiteDatabase<"sync", unknown, typeof schema>,
  type: string,
  key: string,
  opts?: {
    limit?: number;
    includeValues?: boolean;
  },
): { items: RecordHistoryItem[]; total: number; next_cursor: string | null } {
  const effectiveLimit = Math.min(Math.max(opts?.limit ?? 20, 1), 200);

  const whereClause = and(
    eq(schema.recordRevisions.type, type),
    eq(schema.recordRevisions.key, key),
  );

  // COUNT(*)
  const countResult = db
    .select({ count: sql<number>`count(*)` })
    .from(schema.recordRevisions)
    .where(whereClause)
    .get();
  const total = countResult?.count ?? 0;

  // Data query, newest-first
  const rows = db
    .select()
    .from(schema.recordRevisions)
    .where(whereClause)
    .orderBy(desc(schema.recordRevisions.revision))
    .limit(effectiveLimit + 1)
    .all();

  const truncated = rows.length > effectiveLimit;
  const resultRows = truncated ? rows.slice(0, effectiveLimit) : rows;
  const next_cursor = truncated ? "truncated" : null;

  const items: RecordHistoryItem[] = resultRows.map((r) => {
    const item: RecordHistoryItem = {
      type: r.type,
      key: r.key,
      revision: r.revision,
      // The DB column is typed as a plain string, but the
      // `record_revisions_operation_check` CHECK constraint in schema.ts
      // restricts it to the canonical operation literals at the storage layer,
      // so narrowing to the enum here is sound.
      operation: r.operation as RecordHistoryItem["operation"],
      schema_version: r.schema_version,
      value_sha256: r.value_sha256,
      canonical_artifact_key: r.canonical_artifact_key,
      source_artifact_key: r.source_artifact_key,
      actor: r.actor,
      created_at: r.created_at,
      message: r.message,
    };
    if (opts?.includeValues) {
      item.value = JSON.parse(r.value_json) as Record<string, unknown>;
    }
    return item;
  });

  return { items, total, next_cursor };
}

// ---------------------------------------------------------------------------
// listRecordTypesInUse — distinct types from active records
// ---------------------------------------------------------------------------

export function listRecordTypesInUse(
  db: BaseSQLiteDatabase<"sync", unknown, typeof schema>,
): string[] {
  const rows = db
    .selectDistinct({ type: schema.records.type })
    .from(schema.records)
    .where(eq(schema.records.archived, 0))
    .all();
  return rows.map((r) => r.type).sort();
}

// ---------------------------------------------------------------------------
// stampArtifacts -- update revision row with artifact keys (post-patch R2 write)
// ---------------------------------------------------------------------------

export function stampArtifacts(
  db: BaseSQLiteDatabase<"sync", unknown, typeof schema>,
  input: {
    type: string;
    key: string;
    revision: number;
    canonical_artifact_key: string;
    source_artifact_key: string | null;
  },
): void {
  db.transaction((tx) => {
    // Verify the exact revision exists before modifying
    const existing = tx
      .select()
      .from(schema.recordRevisions)
      .where(
        and(
          eq(schema.recordRevisions.type, input.type),
          eq(schema.recordRevisions.key, input.key),
          eq(schema.recordRevisions.revision, input.revision),
        ),
      )
      .get();

    if (!existing) {
      throw new RevisionNotFoundError(input.type, input.key, input.revision);
    }

    // Update artifact keys on the revision row
    tx.update(schema.recordRevisions)
      .set({
        canonical_artifact_key: input.canonical_artifact_key,
        source_artifact_key: input.source_artifact_key,
      })
      .where(
        and(
          eq(schema.recordRevisions.type, input.type),
          eq(schema.recordRevisions.key, input.key),
          eq(schema.recordRevisions.revision, input.revision),
        ),
      )
      .run();
  });
}
