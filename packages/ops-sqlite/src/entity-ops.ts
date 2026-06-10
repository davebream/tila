import { applyLegacyDefaults } from "@tila/core";
import type {
  ArtifactSearchResult,
  CompactEntity,
  Entity,
  RecordSearchResult,
} from "@tila/schemas";
import { TagsSchema } from "@tila/schemas";
import type { TilaSchemaToml } from "@tila/schemas";
import { type SQL, and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import {
  SearchQueryError,
  searchArtifacts,
  validateFtsQuery,
} from "./artifact-ops";
import { entitySearchText } from "./entity-search-text";
import { assertResourceFence } from "./fence-ops";
import { checkPendingGates } from "./gate-ops";
import { type RequestOrigin, appendJournal } from "./journal-ops";
import { searchRecords } from "./record-ops";
import * as schema from "./schema";
import { getSchemaByVersion } from "./schema-ops";
import { tagExistsConditions } from "./tag-filter-ops";

export class EntityNotFoundError extends Error {
  constructor(public readonly entityId: string) {
    super(`Entity not found: ${entityId}`);
    this.name = "EntityNotFoundError";
  }
}

export class EntityAlreadyExistsError extends Error {
  constructor(public readonly entityId: string) {
    super(`Entity already exists: ${entityId}`);
    this.name = "EntityAlreadyExistsError";
  }
}

/**
 * Convert a JSON scalar dataFilter value into the value `json_extract` returns,
 * so equality comparisons match. `json_extract(data, '$.k')` UNQUOTES scalars
 * (returns `P`, not `"P"`), so the bound value must be the raw primitive — NOT
 * `JSON.stringify(value)` (which would compare against `"P"` and never match).
 * Booleans map to SQLite's 1/0 (json_extract yields integers for JSON booleans).
 * Objects/arrays are stringified as a last resort (deep equality is unsupported).
 */
function jsonExtractValue(value: unknown): string | number {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") return value;
  if (typeof value === "string") return value;
  // null/object/array are not supported scalars for `json_extract` equality —
  // `json_extract` returns a SQLite NULL for a JSON `null` (so `= 'null'` never
  // matches) and a JSON *text* for objects/arrays (so deep equality won't hold).
  // We fall back to JSON text, which intentionally MATCHES NOTHING for these
  // shapes; callers should pass scalar dataFilter values.
  return JSON.stringify(value);
}

export type EnrichOpts = {
  db: BaseSQLiteDatabase<"sync", unknown, typeof schema>;
  parseSchemaToml: (
    toml: string,
  ) => { ok: true; schema: TilaSchemaToml } | { ok: false; errors: unknown[] };
};

function enrichEntity(
  entity: Entity,
  entitySchemaCache: Map<number, TilaSchemaToml | null>,
  opts: EnrichOpts,
): Entity {
  let parsed = entitySchemaCache.get(entity.schema_version);
  if (parsed === undefined) {
    const row = getSchemaByVersion(opts.db, entity.schema_version);
    if (row) {
      const result = opts.parseSchemaToml(row.definition);
      parsed = result.ok ? result.schema : null;
    } else {
      parsed = null;
    }
    entitySchemaCache.set(entity.schema_version, parsed);
  }
  if (!parsed) return entity;
  return applyLegacyDefaults(entity, parsed, entity.type);
}

function rowToEntity(row: typeof schema.entities.$inferSelect): Entity {
  return {
    id: row.id,
    type: row.type,
    schema_version: row.schema_version,
    data: JSON.parse(row.data) as Record<string, unknown>,
    archived: row.archived,
    created_at: row.created_at,
    updated_at: row.updated_at,
    created_by: row.created_by,
    tags: [], // populated by get/list after tag read; rowToEntity cannot read tags
  };
}

export function create(
  db: BaseSQLiteDatabase<"sync", unknown, typeof schema>,
  input: {
    id: string;
    type: string;
    data: Record<string, unknown>;
    created_by: string;
    tags?: string[];
  },
  schemaVersion: number,
  origin: RequestOrigin,
): Entity {
  const now = Date.now();
  // Validate + normalize tags before the transaction to avoid holding the lock
  const normalizedTags =
    input.tags !== undefined ? (TagsSchema.parse(input.tags) as string[]) : [];

  return db.transaction((tx) => {
    try {
      tx.insert(schema.entities)
        .values({
          id: input.id,
          type: input.type,
          schema_version: schemaVersion,
          data: JSON.stringify(input.data),
          archived: 0,
          created_at: now,
          updated_at: now,
          created_by: input.created_by,
        })
        .run();
    } catch (err) {
      if (
        err instanceof Error &&
        err.message.includes("UNIQUE constraint failed")
      ) {
        throw new EntityAlreadyExistsError(input.id);
      }
      throw err;
    }

    // Insert tags AFTER the entity-insert try/catch so a tag-PK collision
    // is never misclassified as EntityAlreadyExistsError.
    for (const tag of normalizedTags) {
      tx.insert(schema.entityTags).values({ entity_id: input.id, tag }).run();
    }

    appendJournal(tx, {
      kind: "entity.created",
      resource: input.id,
      actor: origin.actor,
      fence: null,
      tokenId: origin.tokenId,
      source: origin.source,
      sourceVersion: origin.sourceVersion,
    });

    // FTS5: index entity for full-text search (data.title, fallback data.name -- issue #412)
    const entityName = entitySearchText(input.data as Record<string, unknown>);
    tx.run(
      sql`INSERT OR REPLACE INTO entity_search_docs(
        entity_id, entity_type, name, indexed_at
      ) VALUES(
        ${input.id}, ${input.type}, ${entityName}, ${now}
      )`,
    );

    const row = tx
      .select()
      .from(schema.entities)
      .where(eq(schema.entities.id, input.id))
      .get();

    const entity = rowToEntity(row as typeof schema.entities.$inferSelect);
    entity.tags = normalizedTags;
    return entity;
  });
}

export function get(
  db: BaseSQLiteDatabase<"sync", unknown, typeof schema>,
  id: string,
  enrichOpts?: EnrichOpts,
): Entity | null {
  const row = db
    .select()
    .from(schema.entities)
    .where(eq(schema.entities.id, id))
    .get();

  if (!row) return null;
  const entity = rowToEntity(row);

  // Read tags for this entity
  const tagRows = db
    .select()
    .from(schema.entityTags)
    .where(eq(schema.entityTags.entity_id, id))
    .all();
  entity.tags = tagRows.map((t) => t.tag);

  if (!enrichOpts) return entity;
  const cache = new Map<number, TilaSchemaToml | null>();
  return enrichEntity(entity, cache, enrichOpts);
}

export function list(
  db: BaseSQLiteDatabase<"sync", unknown, typeof schema>,
  filter?: {
    type?: string | string[];
    archived?: 0 | 1;
    dataFilter?: Record<string, unknown>;
    sort?: "created_at" | "updated_at" | "type" | "title" | "status";
    order?: "asc" | "desc";
    limit?: number;
    offset?: number;
    tag?: string;
    tagFilter?: string[];
  },
  enrichOpts?: EnrichOpts,
): { entities: Entity[]; total: number } {
  const conditions: SQL[] = [];

  if (filter?.type) {
    if (Array.isArray(filter.type)) {
      conditions.push(inArray(schema.entities.type, filter.type));
    } else {
      conditions.push(eq(schema.entities.type, filter.type));
    }
  }
  if (filter?.archived !== undefined) {
    conditions.push(eq(schema.entities.archived, filter.archived));
  }
  if (filter?.dataFilter) {
    for (const [key, value] of Object.entries(filter.dataFilter)) {
      if (Array.isArray(value)) {
        const placeholders = value.map((v) => sql`${jsonExtractValue(v)}`);
        conditions.push(
          sql`json_extract(${schema.entities.data}, ${`$.${key}`}) IN (${sql.join(placeholders, sql.raw(", "))})`,
        );
      } else {
        conditions.push(
          sql`json_extract(${schema.entities.data}, ${`$.${key}`}) = ${jsonExtractValue(value)}`,
        );
      }
    }
  }
  if (filter?.tag) {
    conditions.push(
      sql`EXISTS (SELECT 1 FROM entity_tags et WHERE et.entity_id = ${schema.entities.id} AND et.tag = ${filter.tag})`,
    );
  }
  if (filter?.tagFilter?.length) {
    const normalizedTags = filter.tagFilter.map((t) => t.toLowerCase());
    conditions.push(
      ...tagExistsConditions(
        "entity_tags",
        sql`jt.entity_id = ${schema.entities.id}`,
        normalizedTags,
      ),
    );
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  // COUNT(*) for total -- same WHERE conditions, no ORDER/LIMIT
  const countResult = db
    .select({ count: sql<number>`count(*)` })
    .from(schema.entities)
    .where(whereClause)
    .get();
  const total = countResult?.count ?? 0;

  // Build the main query
  let query = db.select().from(schema.entities).where(whereClause).$dynamic();

  // ORDER BY
  if (filter?.sort) {
    const sortColumnMap: Record<
      string,
      | SQL
      | typeof schema.entities.created_at
      | typeof schema.entities.updated_at
      | typeof schema.entities.type
    > = {
      created_at: schema.entities.created_at,
      updated_at: schema.entities.updated_at,
      type: schema.entities.type,
      title: sql`json_extract(${schema.entities.data}, '$.title')`,
      status: sql`json_extract(${schema.entities.data}, '$.status')`,
    };
    const sortCol = sortColumnMap[filter.sort];
    if (sortCol) {
      const orderFn = filter.order === "desc" ? desc : asc;
      query = query.orderBy(orderFn(sortCol as Parameters<typeof asc>[0]));
    } else {
      console.warn(
        `[tila] Unknown sort field "${filter.sort}", defaulting to created_at`,
      );
      const orderFn = filter.order === "desc" ? desc : asc;
      query = query.orderBy(orderFn(schema.entities.created_at));
    }
  }

  // LIMIT / OFFSET
  if (filter?.limit !== undefined) {
    query = query.limit(filter.limit);
  }
  if (filter?.offset !== undefined && filter.offset > 0) {
    query = query.offset(filter.offset);
  }

  const rows = query.all();
  const entities = rows.map(rowToEntity);

  // Batch tag enrichment: single IN query over all returned entities (no N+1)
  if (entities.length > 0) {
    const ids = entities.map((e) => e.id);
    const allTags = db
      .select()
      .from(schema.entityTags)
      .where(inArray(schema.entityTags.entity_id, ids))
      .all();

    // Build tag map: entity_id -> tags[]
    const tagMap = new Map<string, string[]>();
    for (const t of allTags) {
      const arr = tagMap.get(t.entity_id) ?? [];
      arr.push(t.tag);
      tagMap.set(t.entity_id, arr);
    }

    for (const entity of entities) {
      entity.tags = tagMap.get(entity.id) ?? [];
    }
  }

  if (!enrichOpts) return { entities, total };
  const cache = new Map<number, TilaSchemaToml | null>();
  return {
    entities: entities.map((e) => enrichEntity(e, cache, enrichOpts)),
    total,
  };
}

/**
 * Transform a full entity into the compact API representation.
 * Requires pre-fetched active claims to avoid N+1 claim lookups.
 */
export function compactEntity(
  db: BaseSQLiteDatabase<"sync", unknown, typeof schema>,
  entity: Entity,
  activeClaims: Array<{ resource: string; machine: string; user: string }>,
): CompactEntity {
  const data = entity.data as Record<string, unknown>;
  const resource = `${entity.type}:${entity.id}`;
  const claim = activeClaims.find((c) => c.resource === resource) ?? null;

  const blockerRows = db.all<{ cnt: number }>(sql`
    SELECT COUNT(*) as cnt FROM entity_relationships
    WHERE to_id = ${entity.id} AND type IN ('blocks', 'soft-blocks')
  `);
  const blockers = blockerRows[0]?.cnt ?? 0;

  const artifactRows = db.all<{ cnt: number }>(sql`
    SELECT COUNT(*) as cnt FROM entity_artifact_references
    WHERE entity_id = ${entity.id}
  `);
  const artifacts = artifactRows[0]?.cnt ?? 0;

  return {
    id: entity.id,
    type: entity.type,
    title: (data.title as string | undefined) ?? null,
    status: (data.status as string | undefined) ?? null,
    claimed_by: claim ? `${claim.machine}/${claim.user}` : null,
    blockers,
    artifacts,
  };
}

export function update(
  db: BaseSQLiteDatabase<"sync", unknown, typeof schema>,
  id: string,
  data: Record<string, unknown>,
  fence: number,
  origin: RequestOrigin,
  tags?: string[],
): Entity {
  // Validate + normalize tags before the transaction
  const normalizedTags =
    tags !== undefined ? (TagsSchema.parse(tags) as string[]) : undefined;

  return db.transaction((tx) => {
    const existing = tx
      .select()
      .from(schema.entities)
      .where(eq(schema.entities.id, id))
      .get();

    if (!existing) {
      throw new EntityNotFoundError(id);
    }

    // Fence validation: always required -- caller must hold a valid claim.
    assertResourceFence(tx, id, fence);

    // Gate enforcement: block terminal transitions if pending gates exist.
    // Non-terminal status changes and updates without a status field are unaffected.
    const TERMINAL_STATUSES = new Set(["done", "closed", "merged"]);
    const incomingStatus = data.status as string | undefined;
    if (incomingStatus && TERMINAL_STATUSES.has(incomingStatus)) {
      checkPendingGates(tx, id, Date.now());
    }

    // Merge data: spread existing + new fields (passthrough preservation)
    const existingData = JSON.parse(existing.data) as Record<string, unknown>;
    const mergedData = { ...existingData, ...data };
    const now = Date.now();

    tx.update(schema.entities)
      .set({
        data: JSON.stringify(mergedData),
        updated_at: now,
      })
      .where(eq(schema.entities.id, id))
      .run();

    // Tag update: undefined=preserve, []=clear, [...]= replace
    if (normalizedTags !== undefined) {
      tx.delete(schema.entityTags)
        .where(eq(schema.entityTags.entity_id, id))
        .run();
      for (const tag of normalizedTags) {
        tx.insert(schema.entityTags).values({ entity_id: id, tag }).run();
      }
    }

    appendJournal(tx, {
      kind: "entity.updated",
      resource: id,
      actor: origin.actor,
      fence: fence,
      tokenId: origin.tokenId,
      source: origin.source,
      sourceVersion: origin.sourceVersion,
    });

    // FTS5: re-index entity for full-text search (data.title, fallback data.name -- issue #412)
    const updatedName = entitySearchText(mergedData as Record<string, unknown>);
    tx.run(
      sql`INSERT OR REPLACE INTO entity_search_docs(
        entity_id, entity_type, name, indexed_at
      ) VALUES(
        ${id}, ${existing.type}, ${updatedName}, ${now}
      )`,
    );

    const updated = tx
      .select()
      .from(schema.entities)
      .where(eq(schema.entities.id, id))
      .get();

    const entity = rowToEntity(updated as typeof schema.entities.$inferSelect);

    // Attach final tags: if we updated them, use normalizedTags; else read current tags
    if (normalizedTags !== undefined) {
      entity.tags = normalizedTags;
    } else {
      const tagRows = tx
        .select()
        .from(schema.entityTags)
        .where(eq(schema.entityTags.entity_id, id))
        .all();
      entity.tags = tagRows.map((t) => t.tag);
    }

    return entity;
  });
}

export function archive(
  db: BaseSQLiteDatabase<"sync", unknown, typeof schema>,
  id: string,
  fence: number,
  origin: RequestOrigin,
): void {
  db.transaction((tx) => {
    const existing = tx
      .select()
      .from(schema.entities)
      .where(eq(schema.entities.id, id))
      .get();

    if (!existing) {
      throw new EntityNotFoundError(id);
    }

    // Fence validation: always required -- caller must hold a valid claim.
    assertResourceFence(tx, id, fence);

    // Gate enforcement: archive is a terminal operation -- always check gates.
    // If GateBlockedError is thrown, the transaction rolls back cleanly.
    // The entity's claim remains valid; caller can retry after resolving gates.
    checkPendingGates(tx, id, Date.now());

    // Delete claim rows atomically inside the archive transaction.
    // Handles both bare-id and typed-resource claim conventions.
    tx.delete(schema.claims).where(eq(schema.claims.resource, id)).run();
    const entityType = existing.type;
    tx.delete(schema.claims)
      .where(eq(schema.claims.resource, `${entityType}:${id}`))
      .run();

    const now = Date.now();

    tx.update(schema.entities)
      .set({
        archived: 1,
        updated_at: now,
      })
      .where(eq(schema.entities.id, id))
      .run();

    appendJournal(tx, {
      kind: "entity.archived",
      resource: id,
      actor: origin.actor,
      fence: fence,
      tokenId: origin.tokenId,
      source: origin.source,
      sourceVersion: origin.sourceVersion,
    });

    // FTS5: remove entity from search index (esd_ad trigger cleans up FTS5)
    tx.run(sql`DELETE FROM entity_search_docs WHERE entity_id = ${id}`);
  });
}

// ---------- Full-text search ----------

export interface EntitySearchResult {
  entity_id: string;
  entity_type: string;
  name: string | null;
  data: Record<string, unknown>;
  indexed_at: number;
  snippet: string | null;
}

/**
 * Full-text search across indexed entities using FTS5.
 *
 * Results are ordered by bm25 relevance (ascending bm25 score = most relevant first).
 * Only non-archived entities are returned.
 */
export function searchEntities(
  db: BaseSQLiteDatabase<"sync", unknown, typeof schema>,
  query: {
    q: string;
    entity_type?: string;
    limit?: number;
    tagFilter?: string[];
  },
): EntitySearchResult[] {
  validateFtsQuery(query.q);
  const limit = Math.min(query.limit ?? 20, 100);

  const tagConditions = query.tagFilter?.length
    ? tagExistsConditions(
        "entity_tags",
        sql`jt.entity_id = d.entity_id`,
        query.tagFilter.map((t) => t.toLowerCase()),
      )
    : [];

  try {
    const rows = db.all<{
      entity_id: string;
      entity_type: string;
      name: string | null;
      data: string;
      indexed_at: number;
      snippet: string | null;
    }>(sql`
      SELECT
        d.entity_id,
        d.entity_type,
        d.name,
        e.data,
        d.indexed_at,
        snippet(entity_search_docs_fts, 0, '<b>', '</b>', '...', 10) AS snippet
      FROM entity_search_docs_fts fts
      JOIN entity_search_docs d ON d.rowid = fts.rowid
      JOIN entities e ON e.id = d.entity_id
      WHERE entity_search_docs_fts MATCH ${query.q}
        AND e.archived = 0
        ${query.entity_type ? sql`AND d.entity_type = ${query.entity_type}` : sql``}
        ${tagConditions.length ? sql`AND ${sql.join(tagConditions, sql.raw(" AND "))}` : sql``}
      ORDER BY bm25(entity_search_docs_fts)
      LIMIT ${limit}
    `);

    return rows.map((r) => ({
      entity_id: r.entity_id,
      entity_type: r.entity_type,
      name: r.name,
      data: JSON.parse(r.data) as Record<string, unknown>,
      indexed_at: r.indexed_at,
      snippet: r.snippet,
    }));
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

export type UnifiedSearchResult =
  | ({ type: "entity" } & EntitySearchResult)
  | ({ type: "artifact" } & ArtifactSearchResult)
  | ({ type: "record" } & RecordSearchResult);

/**
 * Unified full-text search across entities, artifacts, and records.
 *
 * Results from all three FTS5 tables are interleaved using round-robin merge.
 * bm25 scores from different FTS5 tables are not directly comparable (different IDF
 * distributions), so strict cross-table ordering is not attempted.
 */
export function searchAll(
  db: BaseSQLiteDatabase<"sync", unknown, typeof schema>,
  query: { q: string; limit?: number; tagFilter?: string[] },
): UnifiedSearchResult[] {
  const limit = Math.min(query.limit ?? 20, 100);
  // Over-fetch from each source to allow interleaving (3 sources now)
  const perSourceLimit = Math.ceil(limit / 3) + 5;

  const entities = searchEntities(db, {
    q: query.q,
    limit: perSourceLimit,
    tagFilter: query.tagFilter,
  });
  const artifacts = searchArtifacts(db, {
    q: query.q,
    limit: perSourceLimit,
    tagFilter: query.tagFilter,
  });
  const records = searchRecords(db, {
    q: query.q,
    limit: perSourceLimit,
    tagFilter: query.tagFilter,
  });

  const entityResults: UnifiedSearchResult[] = entities.map((r) => ({
    type: "entity" as const,
    ...r,
  }));
  const artifactResults: UnifiedSearchResult[] = artifacts.map((r) => ({
    type: "artifact" as const,
    ...r,
  }));
  const recordResults: UnifiedSearchResult[] = records.map((r) => ({
    type: "record" as const,
    ...r,
  }));

  return mergeRoundRobin(
    [entityResults, artifactResults, recordResults],
    limit,
  );
}

function mergeRoundRobin(
  sources: UnifiedSearchResult[][],
  limit: number,
): UnifiedSearchResult[] {
  const result: UnifiedSearchResult[] = [];
  const indices = sources.map(() => 0);
  while (result.length < limit) {
    let added = false;
    for (let s = 0; s < sources.length; s++) {
      if (result.length >= limit) break;
      if (indices[s] < sources[s].length) {
        result.push(sources[s][indices[s]++]);
        added = true;
      }
    }
    if (!added) break;
  }
  return result;
}
