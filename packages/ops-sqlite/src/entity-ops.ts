import { applyLegacyDefaults } from "@tila/core";
import type {
  NamespaceRestrictions,
  TypeCount,
  WorkPresentation,
} from "@tila/schemas";
import type {
  ArtifactSearchResult,
  CompactEntity,
  Entity,
  RecordSearchResult,
} from "@tila/schemas";
import { TagsSchema, presentedTitle } from "@tila/schemas";
import type { TilaSchemaToml } from "@tila/schemas";
import {
  type SQL,
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  inArray,
  sql,
} from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import {
  SearchQueryError,
  searchArtifacts,
  validateFtsQuery,
} from "./artifact-ops";
import { assertArtifactReviewPolicy } from "./artifact-review-ops";
import {
  assertCurrentEntityWrite,
  resolveCurrentSchema,
} from "./constraint-ops";
import { taskRestrictionCondition } from "./credential-policy";
import { type DoIdempotency, withDoIdempotency } from "./do-idempotency-ops";
import { entitySearchText } from "./entity-search-text";
import {
  assertResourceFence,
  assertResourceFenceWithCanonical,
  resolveEntityResourceDirect,
} from "./fence-ops";
import { checkPendingGates } from "./gate-ops";
import { type RequestOrigin, appendJournal } from "./journal-ops";
import {
  InvalidCursorError,
  decodeCursor,
  encodeCursor,
  fingerprint,
} from "./list-cursor";
import { assertUnmanagedArchive, checkManagedWrite } from "./managed-work";
import { searchRecords } from "./record-ops";
import * as schema from "./schema";
import { SchemaCorruptError } from "./schema-errors";
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

export type CompactEntityStats = {
  blockersByEntityId: ReadonlyMap<string, number>;
  artifactsByEntityId: ReadonlyMap<string, number>;
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
      if (!result.ok) {
        throw new SchemaCorruptError(
          `Stored schema (version ${entity.schema_version}) failed to parse during entity enrichment: ${String(result.errors?.[0] ?? "unknown parse error")}`,
        );
      }
      parsed = result.schema;
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
    const current = assertCurrentEntityWrite(tx, input.type, input.data);
    assertArtifactReviewPolicy(tx, input.id, input.type, input.data.status);
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
      ...origin,
      fence: null,
      tokenId: origin.tokenId,
      source: origin.source,
      sourceVersion: origin.sourceVersion,
    });

    // FTS5: index entity for full-text search (presentation title, else data.title, then data.name -- #412, #300)
    const entityName = entitySearchText(
      input.data as Record<string, unknown>,
      current?.work_units[input.type]?.presentation,
    );
    tx.run(
      sql`INSERT OR REPLACE INTO entity_search_docs(
        entity_id, entity_type, name, indexed_at
      ) VALUES(
        ${input.id}, ${input.type}, ${entityName}, ${now}
      )`,
    );

    // Construct the return value from validated inputs — no post-write SELECT needed.
    const entity: Entity = {
      id: input.id,
      type: input.type,
      schema_version: schemaVersion,
      data: input.data,
      archived: 0,
      created_at: now,
      updated_at: now,
      created_by: input.created_by,
      tags: normalizedTags,
    };
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

export type TaskListSort =
  | "created_at"
  | "updated_at"
  | "type"
  | "title"
  | "status"
  | "id";

/** SQL expression each sort key orders by. `id` is always the tie-break. */
function sortExpression(sort: TaskListSort): SQL | null {
  switch (sort) {
    case "created_at":
      return sql`${schema.entities.created_at}`;
    case "updated_at":
      return sql`${schema.entities.updated_at}`;
    case "type":
      return sql`${schema.entities.type}`;
    case "title":
      return sql`json_extract(${schema.entities.data}, '$.title')`;
    case "status":
      return sql`json_extract(${schema.entities.data}, '$.status')`;
    case "id":
      return null;
    default:
      // Unvalidated callers fall back to the documented default order.
      return sql`${schema.entities.created_at}`;
  }
}

/**
 * Rows strictly after (`dir` asc) or before (`dir` desc) the cursor position
 * in `(expr, id)` order. SQLite sorts NULL first ascending and last
 * descending, so a NULL key needs its own branch.
 */
function keysetCondition(
  expr: SQL | null,
  last: { k: unknown; id: string },
  dir: "asc" | "desc",
): SQL {
  const id = schema.entities.id;
  const idAfter =
    dir === "asc" ? sql`${id} > ${last.id}` : sql`${id} < ${last.id}`;
  if (expr === null) return idAfter;
  if (last.k === null) {
    return dir === "asc"
      ? sql`((${expr} IS NULL AND ${idAfter}) OR ${expr} IS NOT NULL)`
      : sql`(${expr} IS NULL AND ${idAfter})`;
  }
  const value = last.k as string | number;
  return dir === "asc"
    ? sql`(${expr} > ${value} OR (${expr} = ${value} AND ${idAfter}))`
    : sql`(${expr} < ${value} OR (${expr} = ${value} AND ${idAfter}) OR ${expr} IS NULL)`;
}

export function list(
  db: BaseSQLiteDatabase<"sync", unknown, typeof schema>,
  filter?: {
    type?: string | string[];
    restrictions?: NamespaceRestrictions;
    archived?: 0 | 1;
    dataFilter?: Record<string, unknown>;
    /** Defaults to `created_at`. Every order is tie-broken by `id`. */
    sort?: TaskListSort;
    order?: "asc" | "desc";
    limit?: number;
    offset?: number;
    /** Opaque keyset cursor from a previous page's `next_cursor`. */
    cursor?: string;
    tag?: string;
    tagFilter?: string[];
  },
  enrichOpts?: EnrichOpts,
): { entities: Entity[]; total: number; next_cursor: string | null } {
  const conditions: SQL[] = [];
  const restricted = taskRestrictionCondition(db, filter?.restrictions);
  if (restricted) conditions.push(restricted);

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

  // COUNT(*) for total -- same WHERE conditions, no keyset/ORDER/LIMIT
  const countResult = db
    .select({ count: sql<number>`count(*)` })
    .from(schema.entities)
    .where(whereClause)
    .get();
  const total = countResult?.count ?? 0;

  const sort: TaskListSort = filter?.sort ?? "created_at";
  const dir = filter?.order === "desc" ? "desc" : "asc";
  const expr = sortExpression(sort);
  const binding = fingerprint({
    type:
      filter?.type === undefined ? null : [filter.type].flat().slice().sort(),
    archived: filter?.archived ?? null,
    dataFilter: filter?.dataFilter ?? null,
    tag: filter?.tag ?? null,
    tagFilter: filter?.tagFilter?.map((t) => t.toLowerCase()).sort() ?? null,
    sort,
    order: dir,
  });

  const pageConditions = [...conditions];
  if (filter?.cursor) {
    if (filter.offset !== undefined && filter.offset > 0)
      throw new InvalidCursorError("cursor and offset cannot be combined");
    const position = decodeCursor(filter.cursor, binding);
    const k = position.k;
    if (
      typeof position.id !== "string" ||
      !(k === null || typeof k === "string" || typeof k === "number")
    )
      throw new InvalidCursorError();
    pageConditions.push(keysetCondition(expr, { k, id: position.id }, dir));
  }

  const orderFn = dir === "desc" ? desc : asc;
  let query = db
    .select({
      ...getTableColumns(schema.entities),
      sort_key: expr ?? sql`NULL`,
    })
    .from(schema.entities)
    .where(pageConditions.length > 0 ? and(...pageConditions) : undefined)
    .orderBy(
      ...(expr ? [orderFn(expr as unknown as Parameters<typeof asc>[0])] : []),
      orderFn(schema.entities.id),
    )
    .$dynamic();

  // LIMIT+1 probes for a next page without a second query.
  if (filter?.limit !== undefined) {
    query = query.limit(filter.limit + 1);
  }
  if (!filter?.cursor && filter?.offset !== undefined && filter.offset > 0) {
    query = query.offset(filter.offset);
  }

  const fetched = query.all();
  const hasNext = filter?.limit !== undefined && fetched.length > filter.limit;
  const rows = hasNext ? fetched.slice(0, filter?.limit) : fetched;
  const last = rows.at(-1);
  const next_cursor =
    hasNext && last
      ? encodeCursor(binding, {
          k: expr ? (last.sort_key ?? null) : null,
          id: last.id,
        })
      : null;
  const entities = rows.map(({ sort_key: _sortKey, ...row }) =>
    rowToEntity(row),
  );

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

  if (!enrichOpts) return { entities, total, next_cursor };
  const cache = new Map<number, TilaSchemaToml | null>();
  return {
    entities: entities.map((e) => enrichEntity(e, cache, enrichOpts)),
    total,
    next_cursor,
  };
}

/**
 * Count stored tasks per type, split by archived state. Rows the caller may
 * not read (including children of forbidden parents) are not counted.
 */
export function countByType(
  db: BaseSQLiteDatabase<"sync", unknown, typeof schema>,
  restrictions?: NamespaceRestrictions,
): TypeCount[] {
  return db
    .select({
      type: schema.entities.type,
      count: sql<number>`coalesce(sum(case when ${schema.entities.archived} = 0 then 1 else 0 end), 0)`,
      archived_count: sql<number>`coalesce(sum(case when ${schema.entities.archived} = 0 then 0 else 1 end), 0)`,
    })
    .from(schema.entities)
    .where(taskRestrictionCondition(db, restrictions))
    .groupBy(schema.entities.type)
    .orderBy(asc(schema.entities.type))
    .all()
    .map((row) => ({
      type: row.type,
      count: Number(row.count),
      archived_count: Number(row.archived_count),
    }));
}

/**
 * Transform a full entity into the compact API representation.
 * Requires pre-fetched active claims to avoid N+1 claim lookups.
 */
export function compactEntity(
  db: BaseSQLiteDatabase<"sync", unknown, typeof schema>,
  entity: Entity,
  activeClaims: Array<{
    resource: string;
    principal_id: string;
    participant_id: string;
  }>,
  stats: CompactEntityStats,
  presentation?: WorkPresentation,
): CompactEntity {
  const data = entity.data as Record<string, unknown>;
  const resource = `${entity.type}:${entity.id}`;
  const claim = activeClaims.find((c) => c.resource === resource) ?? null;
  const blockers = stats.blockersByEntityId.get(entity.id) ?? 0;
  const artifacts = stats.artifactsByEntityId.get(entity.id) ?? 0;

  return {
    id: entity.id,
    type: entity.type,
    title: presentedTitle(data, presentation),
    status: (data.status as string | undefined) ?? null,
    claimed_by: claim?.participant_id ?? null,
    blockers,
    artifacts,
  };
}

export function getCompactEntityStats(
  db: BaseSQLiteDatabase<"sync", unknown, typeof schema>,
  entityIds: readonly string[],
): CompactEntityStats {
  if (entityIds.length === 0) {
    return {
      blockersByEntityId: new Map(),
      artifactsByEntityId: new Map(),
    };
  }

  const blockersByEntityId = new Map<string, number>();
  const blockerRows = db
    .select({
      entity_id: schema.entityRelationships.to_id,
      count: sql<number>`count(*)`,
    })
    .from(schema.entityRelationships)
    .where(
      and(
        inArray(schema.entityRelationships.to_id, [...entityIds]),
        inArray(schema.entityRelationships.type, ["blocks", "soft-blocks"]),
      ),
    )
    .groupBy(schema.entityRelationships.to_id)
    .all();
  for (const row of blockerRows) {
    blockersByEntityId.set(row.entity_id, row.count);
  }

  const artifactsByEntityId = new Map<string, number>();
  const artifactRows = db
    .select({
      entity_id: schema.entityArtifactReferences.entity_id,
      count: sql<number>`count(*)`,
    })
    .from(schema.entityArtifactReferences)
    .where(inArray(schema.entityArtifactReferences.entity_id, [...entityIds]))
    .groupBy(schema.entityArtifactReferences.entity_id)
    .all();
  for (const row of artifactRows) {
    artifactsByEntityId.set(row.entity_id, row.count);
  }

  return { blockersByEntityId, artifactsByEntityId };
}

export function update(
  db: BaseSQLiteDatabase<"sync", unknown, typeof schema>,
  id: string,
  data: Record<string, unknown>,
  fence: number,
  origin: RequestOrigin,
  tags?: string[],
  idempotency?: DoIdempotency<Entity>,
): Entity {
  return db.transaction(
    (tx) =>
      withDoIdempotency(tx, idempotency, () =>
        updateInTransaction(tx, id, data, fence, origin, tags),
      ).result,
  );
}

/** Internal primitive for a task transition committed together with an attempt result. */
export function updateInTransaction(
  tx: Parameters<
    Parameters<
      BaseSQLiteDatabase<"sync", unknown, typeof schema>["transaction"]
    >[0]
  >[0],
  id: string,
  data: Record<string, unknown>,
  fence: number,
  origin: RequestOrigin,
  tags?: string[],
  now = Date.now(),
  internalAttemptId?: string,
): Entity {
  const normalizedTags =
    tags !== undefined ? (TagsSchema.parse(tags) as string[]) : undefined;
  const existing = tx
    .select()
    .from(schema.entities)
    .where(eq(schema.entities.id, id))
    .get();

  if (!existing) {
    throw new EntityNotFoundError(id);
  }

  // Fence validation: always required -- caller must hold a LIVE claim.
  // requireLiveClaim closes the zombie-write window where an expired lease's
  // fence still numerically matches current_fence (entity fences do not bump
  // on write).
  // Use the fast path: we already have `existing.type` from the SELECT above,
  // so construct the canonical resource string directly without another DB read.
  const canonicalResource = resolveEntityResourceDirect(existing.type, id);
  const contentOnly = checkManagedWrite(
    tx,
    id,
    data,
    fence,
    origin,
    now,
    internalAttemptId,
  );
  if (!contentOnly)
    assertResourceFenceWithCanonical(tx, canonicalResource, fence, {
      requireLiveClaim: true,
    });

  // Gate enforcement: block terminal transitions if pending gates exist.
  // Non-terminal status changes and updates without a status field are unaffected.
  const lifecycle =
    resolveCurrentSchema(tx)?.work_units[existing.type]?.lifecycle;
  const TERMINAL_STATUSES = new Set(
    lifecycle?.terminal ?? ["done", "closed", "merged"],
  );
  const incomingStatus = data[lifecycle?.field ?? "status"] as
    | string
    | undefined;
  if (!contentOnly && incomingStatus && TERMINAL_STATUSES.has(incomingStatus)) {
    // B5: share the function-level `now` so entity.updated_at and any
    // gate.resolved_at agree (single clock per transaction).
    checkPendingGates(tx, id, now);
    if (lifecycle) checkPendingGates(tx, canonicalResource, now);
  }

  // Merge data: spread existing + new fields (passthrough preservation)
  const existingData = JSON.parse(existing.data) as Record<string, unknown>;
  const mergedData = { ...existingData, ...data };
  const current = assertCurrentEntityWrite(tx, existing.type, mergedData);
  if (mergedData.status !== existingData.status)
    assertArtifactReviewPolicy(tx, id, existing.type, mergedData.status);

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
    ...origin,
    fence: fence,
    tokenId: origin.tokenId,
    source: origin.source,
    sourceVersion: origin.sourceVersion,
  });

  // FTS5: re-index entity for full-text search (presentation title, else data.title, then data.name -- #412, #300)
  const updatedName = entitySearchText(
    mergedData as Record<string, unknown>,
    current?.work_units[existing.type]?.presentation,
  );
  tx.run(
    sql`INSERT OR REPLACE INTO entity_search_docs(
    entity_id, entity_type, name, indexed_at
  ) VALUES(
    ${id}, ${existing.type}, ${updatedName}, ${now}
  )`,
  );

  // Construct the return value from mergedData + the already-read `existing` row.
  // This avoids the post-write SELECT while preserving all passthrough fields:
  // created_at, created_by, type, and schema_version come from `existing`;
  // data comes from `mergedData` (the merged patch applied by the UPDATE above).
  const entity: Entity = {
    id: existing.id,
    type: existing.type,
    schema_version: existing.schema_version,
    data: mergedData,
    archived: existing.archived,
    created_at: existing.created_at,
    updated_at: now,
    created_by: existing.created_by,
    tags: [],
  };

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
}

export function archive(
  db: BaseSQLiteDatabase<"sync", unknown, typeof schema>,
  id: string,
  fence: number,
  origin: RequestOrigin,
  idempotency?: DoIdempotency<{ archived: true }>,
): void {
  // Single clock read for the whole transaction: the archive write and the gate
  // resolution it triggers (checkPendingGates resolving an expired timer gate)
  // must share one timestamp, so entity.updated_at and gate.resolved_at agree.
  const now = Date.now();

  db.transaction((tx) => {
    assertUnmanagedArchive(tx, id);
    // Dedup the fence-validated archive inside this transaction (audit B1): a
    // replay returns without re-running the terminal archive (which would
    // re-delete the claim / re-journal). The route body carries no data, so we
    // dedup on a constant sentinel result.
    withDoIdempotency(tx, idempotency, () => {
      const existing = tx
        .select()
        .from(schema.entities)
        .where(eq(schema.entities.id, id))
        .get();

      if (!existing) {
        throw new EntityNotFoundError(id);
      }

      // Fence validation: always required -- caller must hold a LIVE claim.
      // requireLiveClaim closes the zombie-write window where an expired lease's
      // fence still numerically matches current_fence (entity fences do not bump
      // on write).
      // Use the fast path: we already have `existing.type` from the SELECT above.
      assertResourceFenceWithCanonical(
        tx,
        resolveEntityResourceDirect(existing.type, id),
        fence,
        { requireLiveClaim: true },
      );

      // Gate enforcement: archive is a terminal operation -- always check gates.
      // If GateBlockedError is thrown, the transaction rolls back cleanly.
      // The entity's claim remains valid; caller can retry after resolving gates.
      // B5: share the function-level `now` so updated_at and gate.resolved_at agree.
      checkPendingGates(tx, id, now);

      tx.delete(schema.claims)
        .where(eq(schema.claims.resource, `${existing.type}:${id}`))
        .run();

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
        ...origin,
        fence: fence,
        tokenId: origin.tokenId,
        source: origin.source,
        sourceVersion: origin.sourceVersion,
      });

      // FTS5: remove entity from search index (esd_ad trigger cleans up FTS5)
      tx.run(sql`DELETE FROM entity_search_docs WHERE entity_id = ${id}`);
      return { archived: true as const };
    });
  });
}

// ---------- Full-text search ----------

export interface EntitySearchResult {
  entity_id: string;
  entity_type: string;
  name: string | null;
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
    /** Restrict matches to these task types. */
    entity_types?: string[];
    limit?: number;
    /** Rows to skip in `(bm25, entity_id)` order. */
    offset?: number;
    tagFilter?: string[];
    /** Caller's namespace restrictions; forbidden tasks never match. */
    restrictions?: NamespaceRestrictions;
    /** Internal: skip validation when the caller (searchAll) has already validated. */
    _skipValidation?: boolean;
  },
): EntitySearchResult[] {
  if (!query._skipValidation) validateFtsQuery(query.q);
  const limit = Math.min(query.limit ?? 20, 101);

  const tagConditions = query.tagFilter?.length
    ? tagExistsConditions(
        "entity_tags",
        sql`jt.entity_id = d.entity_id`,
        query.tagFilter.map((t) => t.toLowerCase()),
      )
    : [];
  // The join is unaliased so the shared restriction condition, which renders
  // against "entities", applies here exactly as it does to task lists.
  const restricted = taskRestrictionCondition(db, query.restrictions);
  const types = query.entity_types?.length
    ? query.entity_types
    : query.entity_type
      ? [query.entity_type]
      : undefined;

  try {
    const rows = db.all<{
      entity_id: string;
      entity_type: string;
      name: string | null;
      indexed_at: number;
      snippet: string | null;
    }>(sql`
      SELECT
        d.entity_id,
        d.entity_type,
        d.name,
        d.indexed_at,
        snippet(entity_search_docs_fts, -1, '<b>', '</b>', '...', 10) AS snippet
      FROM entity_search_docs_fts fts
      JOIN entity_search_docs d ON d.rowid = fts.rowid
      JOIN entities ON entities.id = d.entity_id
      WHERE entity_search_docs_fts MATCH ${query.q}
        AND entities.archived = 0
        ${
          types
            ? sql`AND d.entity_type IN (${sql.join(
                types.map((t) => sql`${t}`),
                sql.raw(", "),
              )})`
            : sql``
        }
        ${restricted ? sql`AND ${restricted}` : sql``}
        ${tagConditions.length ? sql`AND ${sql.join(tagConditions, sql.raw(" AND "))}` : sql``}
      ORDER BY bm25(entity_search_docs_fts, 10.0, 1.0), d.entity_id
      LIMIT ${limit}
      ${query.offset ? sql`OFFSET ${query.offset}` : sql``}
    `);

    return rows.map((r) => ({
      entity_id: r.entity_id,
      entity_type: r.entity_type,
      name: r.name,
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
  // Validate the FTS query once here rather than once per sub-search.
  validateFtsQuery(query.q);

  const limit = Math.min(query.limit ?? 20, 100);
  // Over-fetch from each source to allow interleaving (3 sources now)
  const perSourceLimit = Math.ceil(limit / 3) + 5;

  const entities = searchEntities(db, {
    q: query.q,
    limit: perSourceLimit,
    tagFilter: query.tagFilter,
    _skipValidation: true,
  });
  const artifacts = searchArtifacts(db, {
    q: query.q,
    limit: perSourceLimit,
    tagFilter: query.tagFilter,
    _skipValidation: true,
  });
  const records = searchRecords(db, {
    q: query.q,
    limit: perSourceLimit,
    tagFilter: query.tagFilter,
    _skipValidation: true,
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
