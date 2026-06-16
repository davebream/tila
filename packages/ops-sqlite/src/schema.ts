import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

// --- entities ---
export const entities = sqliteTable(
  "entities",
  {
    id: text("id").primaryKey(),
    type: text("type").notNull(),
    schema_version: integer("schema_version").notNull(),
    data: text("data").notNull().default("{}"),
    archived: integer("archived").notNull().default(0),
    created_at: integer("created_at").notNull(),
    updated_at: integer("updated_at").notNull(),
    created_by: text("created_by").notNull(),
  },
  (table) => [index("idx_entities_type").on(table.type)],
);

// --- entity_relationships ---
export const entityRelationships = sqliteTable(
  "entity_relationships",
  {
    from_id: text("from_id").notNull(),
    to_id: text("to_id").notNull(),
    type: text("type").notNull(),
    schema_version: integer("schema_version").notNull(),
    created_at: integer("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.from_id, table.to_id, table.type] }),
    index("idx_entity_relationships_to_id_type").on(table.to_id, table.type),
    check(
      "entity_relationships_from_id_no_slash",
      sql`${table.from_id} NOT LIKE '%/%'`,
    ),
    check(
      "entity_relationships_to_id_no_slash",
      sql`${table.to_id} NOT LIKE '%/%'`,
    ),
  ],
);

// --- artifact_pointers ---
export const artifactPointers = sqliteTable(
  "artifact_pointers",
  {
    r2_key: text("r2_key").primaryKey(),
    resource: text("resource"),
    kind: text("kind").notNull(),
    sha256: text("sha256").notNull(),
    bytes: integer("bytes").notNull(),
    fence: integer("fence"),
    mime_type: text("mime_type").notNull(),
    produced_at: integer("produced_at").notNull(),
    produced_by: text("produced_by").notNull(),
    expires_at: integer("expires_at"),
    tombstoned: integer("tombstoned").notNull().default(0),
    tombstoned_at: integer("tombstoned_at"),
    blob_deleted_at: integer("blob_deleted_at"),
    content_inline: text("content_inline"),
  },
  (table) => [
    index("idx_artifacts_produced").on(table.resource),
    index("idx_artifacts_sources").on(table.r2_key),
    check(
      "artifact_pointers_r2_key_has_slash",
      sql`${table.r2_key} LIKE '%/%'`,
    ),
  ],
);

// --- entity_artifact_references ---
export const entityArtifactReferences = sqliteTable(
  "entity_artifact_references",
  {
    entity_id: text("entity_id").notNull(),
    artifact_key: text("artifact_key").notNull(),
    slot: text("slot").notNull(),
    metadata: text("metadata").default("{}"),
    created_at: integer("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.entity_id, table.artifact_key, table.slot] }),
    check("ear_entity_id_no_slash", sql`${table.entity_id} NOT LIKE '%/%'`),
    check("ear_artifact_key_has_slash", sql`${table.artifact_key} LIKE '%/%'`),
  ],
);

// --- artifact_relationships ---
export const artifactRelationships = sqliteTable(
  "artifact_relationships",
  {
    from_key: text("from_key").notNull(),
    to_key: text("to_key"),
    to_uri: text("to_uri"),
    type: text("type").notNull(),
    target: text("target").notNull(),
    metadata: text("metadata").default("{}"),
    created_at: integer("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.from_key, table.target, table.type] }),
    index("idx_artifact_rels_to_key_type").on(table.to_key, table.type),
    check(
      "artifact_relationships_from_key_has_slash",
      sql`${table.from_key} LIKE '%/%'`,
    ),
  ],
);

// --- journal ---
export const journal = sqliteTable(
  "journal",
  {
    seq: integer("seq").primaryKey({ autoIncrement: true }),
    t: integer("t").notNull(),
    kind: text("kind").notNull(),
    resource: text("resource").notNull(),
    actor: text("actor").notNull(),
    token_id: text("token_id"),
    fence: integer("fence"),
    data: text("data").notNull().default("{}"),
    source: text("source"),
    source_version: text("source_version"),
  },
  (table) => [
    index("idx_journal_resource").on(table.resource),
    index("idx_journal_kind").on(table.kind),
    index("idx_journal_source").on(table.source),
  ],
);

// --- _journal_archive_watermark ---
// Single-row table (id = 1 enforced by CHECK). Tracks the highest journal seq
// that has been archived to R2 and deleted from DO SQLite.
export const journalArchiveWatermark = sqliteTable(
  "_journal_archive_watermark",
  {
    id: integer("id").primaryKey(),
    last_archived_seq: integer("last_archived_seq").notNull(),
    archived_at: integer("archived_at").notNull(),
  },
  (table) => [check("journal_archive_watermark_id_is_1", sql`${table.id} = 1`)],
);

// --- claims ---
export const claims = sqliteTable(
  "claims",
  {
    resource: text("resource").primaryKey(),
    holder: text("holder").notNull(),
    machine: text("machine").notNull(),
    user: text("user").notNull(),
    mode: text("mode").notNull(),
    fence: integer("fence").notNull(),
    acquired_at: integer("acquired_at").notNull(),
    expires_at: integer("expires_at").notNull(),
    metadata: text("metadata").default("{}"),
  },
  (table) => [index("idx_claims_expires").on(table.expires_at)],
);

// --- fences ---
export const fences = sqliteTable("fences", {
  resource: text("resource").primaryKey(),
  current_fence: integer("current_fence").notNull().default(0),
});

// --- presence ---
export const presence = sqliteTable(
  "presence",
  {
    machine: text("machine").primaryKey(),
    last_seen: integer("last_seen").notNull(),
    info: text("info").notNull().default("{}"),
  },
  (table) => [index("idx_presence_last_seen").on(table.last_seen)],
);

// --- _schema_history ---
export const schemaHistory = sqliteTable("_schema_history", {
  version: integer("version").primaryKey(),
  definition: text("definition").notNull(),
  applied_at: integer("applied_at").notNull(),
  applied_by: text("applied_by").notNull(),
  change_summary: text("change_summary"),
  strategy: text("strategy"),
});

// --- artifact_search_docs ---
// Note: FK to artifact_pointers(r2_key) is enforced in the raw SQL migration (MIGRATION_0003).
// The FTS5 virtual table artifact_search_docs_fts exists only in raw SQL -- Drizzle has no FTS5 support.
export const artifactSearchDocs = sqliteTable(
  "artifact_search_docs",
  {
    artifact_key: text("artifact_key").primaryKey(),
    kind: text("kind").notNull(),
    mime_type: text("mime_type").notNull(),
    resource: text("resource"),
    title: text("title"),
    body_text: text("body_text"),
    indexed_at: integer("indexed_at").notNull(),
    source_sha256: text("source_sha256").notNull(),
    tombstoned: integer("tombstoned").notNull().default(0),
  },
  (table) => [
    index("idx_asd_kind").on(table.kind),
    index("idx_asd_resource").on(table.resource),
    index("idx_asd_tombstoned").on(table.tombstoned),
    index("idx_asd_indexed_at").on(table.indexed_at),
  ],
);

// --- entity_search_docs ---
// Note: FK to entities(id) is enforced in the raw SQL migration (MIGRATION_0009).
// The FTS5 virtual table entity_search_docs_fts exists only in raw SQL -- Drizzle has no FTS5 support.
export const entitySearchDocs = sqliteTable(
  "entity_search_docs",
  {
    entity_id: text("entity_id").primaryKey(),
    entity_type: text("entity_type").notNull(),
    name: text("name"),
    indexed_at: integer("indexed_at").notNull(),
  },
  (table) => [
    index("idx_esd_entity_type").on(table.entity_type),
    index("idx_esd_indexed_at").on(table.indexed_at),
  ],
);

// --- gates ---
export const gates = sqliteTable(
  "gates",
  {
    id: text("id").primaryKey(),
    resource: text("resource").notNull(),
    await_type: text("await_type").notNull(),
    status: text("status").notNull().default("pending"),
    fence: integer("fence").notNull(),
    timeout_at: integer("timeout_at"),
    resolved_at: integer("resolved_at"),
    resolution: text("resolution"),
    created_at: integer("created_at").notNull(),
    created_by: text("created_by").notNull(),
    token_id: text("token_id"),
    data: text("data").notNull().default("{}"),
  },
  (table) => [
    index("idx_gates_resource").on(table.resource),
    index("idx_gates_status").on(table.status),
  ],
);

// --- signals ---
export const signals = sqliteTable(
  "signals",
  {
    id: text("id").primaryKey(),
    target: text("target").notNull(),
    kind: text("kind").notNull(),
    resource: text("resource"),
    payload: text("payload").notNull().default("{}"),
    created_by: text("created_by").notNull(),
    created_at: integer("created_at").notNull(),
    expires_at: integer("expires_at").notNull(),
    acked_at: integer("acked_at"),
  },
  (table) => [
    index("idx_signals_target").on(table.target),
    index("idx_signals_expires").on(table.expires_at),
  ],
);

// --- records ---
export const records = sqliteTable(
  "records",
  {
    type: text("type").notNull(),
    key: text("key").notNull(),
    schema_version: integer("schema_version").notNull(),
    value_json: text("value_json").notNull(),
    value_sha256: text("value_sha256").notNull(),
    revision: integer("revision").notNull(),
    archived: integer("archived").notNull().default(0),
    created_at: integer("created_at").notNull(),
    updated_at: integer("updated_at").notNull(),
    updated_by: text("updated_by").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.type, table.key] }),
    index("idx_records_type").on(table.type),
    index("idx_records_archived").on(table.type, table.archived),
  ],
);

// --- entity_tags ---
export const entityTags = sqliteTable(
  "entity_tags",
  {
    entity_id: text("entity_id").notNull(),
    tag: text("tag").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.entity_id, table.tag] }),
    index("idx_entity_tags_tag").on(table.tag),
  ],
);

// --- artifact_tags ---
export const artifactTags = sqliteTable(
  "artifact_tags",
  {
    artifact_key: text("artifact_key").notNull(),
    tag: text("tag").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.artifact_key, table.tag] }),
    index("idx_artifact_tags_tag").on(table.tag),
  ],
);

// --- record_tags ---
export const recordTags = sqliteTable(
  "record_tags",
  {
    type: text("type").notNull(),
    key: text("key").notNull(),
    tag: text("tag").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.type, table.key, table.tag] }),
    index("idx_record_tags_tag").on(table.tag),
  ],
);

// --- record_revisions ---
export const recordRevisions = sqliteTable(
  "record_revisions",
  {
    type: text("type").notNull(),
    key: text("key").notNull(),
    revision: integer("revision").notNull(),
    operation: text("operation").notNull(),
    schema_version: integer("schema_version").notNull(),
    value_json: text("value_json").notNull(),
    value_sha256: text("value_sha256").notNull(),
    canonical_artifact_key: text("canonical_artifact_key"),
    source_artifact_key: text("source_artifact_key"),
    actor: text("actor").notNull(),
    created_at: integer("created_at").notNull(),
    message: text("message"),
    token_id: text("token_id"),
    source: text("source"),
    source_version: text("source_version"),
  },
  (table) => [
    primaryKey({ columns: [table.type, table.key, table.revision] }),
    index("idx_record_revisions_record").on(
      table.type,
      table.key,
      table.revision,
    ),
    check(
      "record_revisions_operation_check",
      sql`${table.operation} IN ('created', 'set', 'patch', 'archived', 'unarchived')`,
    ),
  ],
);

// --- record_search_docs ---
// Note: FK to records(type, key) is enforced in the raw SQL migration (MIGRATION_0011).
// The FTS5 virtual table record_search_docs_fts exists only in raw SQL -- Drizzle has no FTS5 support.
export const recordSearchDocs = sqliteTable(
  "record_search_docs",
  {
    record_type: text("record_type").notNull(),
    record_key: text("record_key").notNull(),
    body_text: text("body_text"),
    indexed_at: integer("indexed_at").notNull(),
    value_sha256: text("value_sha256").notNull(),
    tombstoned: integer("tombstoned").notNull().default(0),
  },
  (table) => [
    primaryKey({ columns: [table.record_type, table.record_key] }),
    index("idx_rsd_indexed_at").on(table.indexed_at),
    index("idx_rsd_tombstoned").on(table.tombstoned),
  ],
);

// --- _idempotency ---
// Embedded-only idempotency overlay. In Cloudflare mode, idempotency lives in D1
// (`@tila/backend-d1`); in embedded mode it lives in the same project SQLite file
// (one fewer store to coordinate). The store is a standalone INSERT OR IGNORE,
// NOT folded into the mutating operation's own transaction. This Drizzle model
// mirrors the DDL in `@tila/backend-embedded`'s MIGRATION_IDEMPOTENCY
// (version 1000) so the embedded backend reads/writes idempotency rows via
// Drizzle instead of raw SQL.
// The table does not exist in DO SQLite (DO idempotency is D1-backed), so no
// canonical migration creates it; only the embedded migration set does.
export const idempotency = sqliteTable(
  "_idempotency",
  {
    key: text("key").primaryKey(),
    created_at: integer("created_at").notNull(),
    response_json: text("response_json").notNull(),
    status_code: integer("status_code").notNull(),
  },
  (table) => [index("idx_idempotency_created").on(table.created_at)],
);
