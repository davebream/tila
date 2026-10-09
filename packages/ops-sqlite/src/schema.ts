import type { ArtifactProvenance } from "@tila/schemas";
import type { Agent } from "@tila/schemas";
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

// --- entities ---
export const agents = sqliteTable("agents", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  owner_principal_id: text("owner_principal_id").notNull(),
  bind_policy: text("bind_policy", { mode: "json" })
    .$type<Agent["bind_policy"]>()
    .notNull(),
  binding_epoch: integer("binding_epoch").notNull().default(0),
  archived: integer("archived", { mode: "boolean" }).notNull().default(false),
  created_at: integer("created_at").notNull(),
  updated_at: integer("updated_at").notNull(),
});
export const agentBindings = sqliteTable(
  "agent_bindings",
  {
    consumer_binding_id: text("consumer_binding_id").primaryKey(),
    agent_id: text("agent_id")
      .notNull()
      .references(() => agents.id),
    run_id: text("run_id").notNull(),
    binding_epoch: integer("binding_epoch").notNull(),
    enrollment_id: text("enrollment_id"),
    workload_binding_id: text("workload_binding_id"),
    principal_id: text("principal_id").notNull(),
    participant_id: text("participant_id").notNull(),
    state: text("state").notNull(),
    attachment_json: text("attachment_json").notNull(),
    lease_expires_at: integer("lease_expires_at").notNull(),
    created_at: integer("created_at").notNull(),
    updated_at: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("agent_bindings_run").on(table.agent_id, table.run_id),
    uniqueIndex("agent_bindings_active")
      .on(table.agent_id)
      .where(sql`${table.state} = 'active'`),
  ],
);

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
    lineage_id: text("lineage_id"),
    revision: integer("revision"),
    restored_from: text("restored_from"),
    provenance: text("provenance", {
      mode: "json",
    }).$type<ArtifactProvenance>(),
    revision_creation: text("revision_creation", {
      mode: "json",
    }).$type<ArtifactProvenance>(),
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
export const artifactLineages = sqliteTable("artifact_lineages", {
  id: text("id").primaryKey(),
  project_id: text("project_id").notNull(),
  kind: text("kind").notNull(),
  resource: text("resource"),
  next_revision: integer("next_revision").notNull().default(1),
  destroyed_at: integer("destroyed_at"),
});

// Permanent metadata, independent of the disposable live pointer projection.
export const artifactRevisions = sqliteTable(
  "artifact_revisions",
  {
    r2_key: text("r2_key").primaryKey(),
    lineage_id: text("lineage_id").notNull(),
    revision: integer("revision").notNull(),
    metadata: text("metadata").notNull(),
    retention_assigned: integer("retention_assigned").notNull().default(0),
  },
  (t) => [uniqueIndex("idx_revision_identity").on(t.lineage_id, t.revision)],
);

export const artifactLifecycleOperations = sqliteTable(
  "artifact_lifecycle_operations",
  {
    id: text("id").primaryKey(),
    lineage_id: text("lineage_id").notNull(),
    record: text("record").notNull(),
    request_id: text("request_id"),
    state: text("state", { enum: ["pending", "published", "done"] })
      .notNull()
      .default("pending"),
    attempts: integer("attempts").notNull().default(0),
    retry_at: integer("retry_at").notNull().default(0),
  },
  (t) => [index("idx_lifecycle_due").on(t.state, t.retry_at)],
);

export const artifactRetentionState = sqliteTable("artifact_retention_state", {
  id: integer("id").primaryKey(),
  policy: text("policy").notNull(),
  cursor: text("cursor"),
  complete: integer("complete").notNull().default(0),
});

export const artifactRevisionOperations = sqliteTable(
  "artifact_revision_operations",
  {
    id: text("id").primaryKey(),
    lineage_id: text("lineage_id").notNull(),
    request_hash: text("request_hash").notNull(),
    state: text("state", {
      enum: ["reserved", "accepted", "published", "aborted"],
    }).notNull(),
    record: text("record").notNull(),
    search_text: text("search_text"),
    created_at: integer("created_at").notNull(),
  },
  (table) => [
    index("idx_artifact_operations_lineage").on(table.lineage_id, table.state),
  ],
);

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
    principal_id: text("principal_id").notNull(),
    participant_id: text("participant_id").notNull(),
    environment: text("environment").notNull().default("{}"),
    // Retained physically for archived-row compatibility; public reads use the
    // canonical identity columns above.
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
    index("idx_journal_participant").on(table.participant_id),
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
    principal_id: text("principal_id").notNull(),
    participant_id: text("participant_id").notNull(),
    environment: text("environment").notNull().default("{}"),
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
    principal_id: text("principal_id").notNull(),
    participant_id: text("participant_id").notNull(),
    environment: text("environment").notNull().default("{}"),
    last_seen: integer("last_seen").notNull(),
    info: text("info").notNull().default("{}"),
  },
  (table) => [
    primaryKey({ columns: [table.principal_id, table.participant_id] }),
    index("idx_presence_last_seen").on(table.last_seen),
  ],
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

// --- signal groups ---
export const signalGroups = sqliteTable("signal_groups", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  created_at: integer("created_at").notNull(),
  updated_at: integer("updated_at").notNull(),
  created_by_principal_id: text("created_by_principal_id").notNull(),
  created_by_participant_id: text("created_by_participant_id").notNull(),
  updated_by_principal_id: text("updated_by_principal_id").notNull(),
  updated_by_participant_id: text("updated_by_participant_id").notNull(),
});

export const signalGroupMembers = sqliteTable(
  "signal_group_members",
  {
    group_id: text("group_id")
      .notNull()
      .references(() => signalGroups.id, { onDelete: "cascade" }),
    principal_id: text("principal_id").notNull(),
    added_at: integer("added_at").notNull(),
    added_by_principal_id: text("added_by_principal_id").notNull(),
    added_by_participant_id: text("added_by_participant_id").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.group_id, table.principal_id] }),
    index("idx_signal_group_members_principal").on(table.principal_id),
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
    sender_principal_id: text("sender_principal_id").notNull(),
    sender_participant_id: text("sender_participant_id").notNull(),
    sender_display_name: text("sender_display_name"),
    sender_environment: text("sender_environment").notNull().default("{}"),
    created_at: integer("created_at").notNull(),
    expires_at: integer("expires_at").notNull(),
  },
  (table) => [index("idx_signals_expires").on(table.expires_at)],
);

export const signalDeliveries = sqliteTable(
  "signal_deliveries",
  {
    signal_id: text("signal_id")
      .notNull()
      .references(() => signals.id, { onDelete: "cascade" }),
    recipient_principal_id: text("recipient_principal_id").notNull(),
    recipient_participant_id: text("recipient_participant_id").notNull(),
    recipient_display_name: text("recipient_display_name"),
    recipient_environment: text("recipient_environment")
      .notNull()
      .default("{}"),
    acknowledged_at: integer("acknowledged_at"),
    acknowledged_by_principal_id: text("acknowledged_by_principal_id"),
    acknowledged_by_participant_id: text("acknowledged_by_participant_id"),
    acknowledged_by_display_name: text("acknowledged_by_display_name"),
    acknowledged_by_environment: text("acknowledged_by_environment"),
  },
  (table) => [
    primaryKey({
      columns: [
        table.signal_id,
        table.recipient_principal_id,
        table.recipient_participant_id,
      ],
    }),
    index("idx_signal_deliveries_inbox").on(
      table.recipient_principal_id,
      table.recipient_participant_id,
      table.acknowledged_at,
    ),
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
// This `_idempotency` table does not exist in DO SQLite; only the embedded
// migration set creates it. DO SQLite has its own dedup table, `_do_idempotency`
// (below), created by canonical migration v21.
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

// --- _do_idempotency ---
// DO-side idempotency dedup, written INSIDE the same DO SQLite transaction as a
// fence-mutating write so the dedup record co-commits with the write (audit
// finding B1). Distinct from the embedded-only `_idempotency` above: this table
// DOES exist in DO SQLite, created by the canonical migration v21
// (MIGRATION_0021). The `request_hash` is nullable to mirror the worker
// middleware's null-hash "always replay" path. See do-idempotency-ops.ts.
//
// FOLLOW-UP (tracked, not in this PR): this table grows unbounded — one row per
// fence-mutating write, forever. The D1 idempotency store has TTL cleanup; this
// DO table has none yet. It needs a GC pass folded into the daily per-project
// sweep (mirroring the D1 idempotency TTL). Until then rows accumulate.
export const doIdempotency = sqliteTable(
  "_do_idempotency",
  {
    key: text("key").primaryKey(),
    request_hash: text("request_hash"),
    status_code: integer("status_code").notNull(),
    response_json: text("response_json").notNull(),
    created_at: integer("created_at").notNull(),
  },
  (table) => [index("idx_do_idempotency_created").on(table.created_at)],
);

export const projectTransferState = sqliteTable("_project_transfer_state", {
  singleton: integer("singleton").primaryKey(),
  session_id: text("session_id").notNull().unique(),
  mode: text("mode").notNull(),
  owner: text("owner").notNull(),
  archive_digest: text("archive_digest"),
  safety_archive: text("safety_archive"),
  started_at: integer("started_at").notNull(),
  updated_at: integer("updated_at").notNull(),
  expires_at: integer("expires_at"),
  applying: integer("applying").notNull().default(0),
  agent_epochs_json: text("agent_epochs_json").notNull().default("{}"),
});

export const projectTransferChunks = sqliteTable(
  "_project_transfer_chunks",
  {
    session_id: text("session_id").notNull(),
    section: text("section").notNull(),
    chunk_index: integer("chunk_index").notNull(),
    sha256: text("sha256").notNull(),
    bytes: integer("bytes").notNull(),
    accepted_at: integer("accepted_at").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.session_id, table.section, table.chunk_index],
    }),
  ],
);

export const journalCursors = sqliteTable(
  "journal_cursors",
  {
    principal_id: text("principal_id").notNull(),
    participant_id: text("participant_id").notNull(),
    seq: integer("seq").notNull(),
    updated_at: integer("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.principal_id, table.participant_id] }),
  ],
);

export const handoffs = sqliteTable(
  "handoffs",
  {
    id: text("id").primaryKey(),
    principal_id: text("principal_id").notNull(),
    participant_id: text("participant_id").notNull(),
    created_seq: integer("created_seq").notNull().unique(),
    request_json: text("request_json").notNull(),
    snapshot: text("snapshot").notNull(),
  },
  (table) => [
    index("idx_handoffs_creator").on(
      table.principal_id,
      table.participant_id,
      table.created_seq,
    ),
  ],
);

export const handoffReferences = sqliteTable(
  "handoff_references",
  {
    handoff_id: text("handoff_id").notNull(),
    resource: text("resource").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.handoff_id, table.resource] }),
    index("idx_handoff_resource").on(table.resource),
  ],
);

export const artifactReviews = sqliteTable(
  "artifact_reviews",
  {
    artifact_key: text("artifact_key").notNull(),
    review_revision: integer("review_revision").notNull(),
    principal_id: text("principal_id").notNull(),
    participant_id: text("participant_id").notNull(),
    created_at: integer("created_at").notNull(),
    decision: text("decision", {
      enum: ["trusted", "rejected", "superseded", "revoked"],
    }).notNull(),
    reason: text("reason"),
    operation_id: text("operation_id").notNull(),
    request_json: text("request_json").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.artifact_key, table.review_revision] }),
    uniqueIndex("idx_artifact_reviews_operation").on(table.operation_id),
  ],
);

export const rooms = sqliteTable("rooms", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  history_policy: text("history_policy").notNull(),
  delivery_ttl_seconds: integer("delivery_ttl_seconds").notNull(),
  budgets: text("budgets", { mode: "json" })
    .$type<import("@tila/schemas").Room["budgets"]>()
    .notNull(),
  archived: integer("archived", { mode: "boolean" }).notNull().default(false),
  next_seq: integer("next_seq").notNull().default(0),
  created_at: integer("created_at").notNull(),
  updated_at: integer("updated_at").notNull(),
});

export const roomMembers = sqliteTable(
  "room_members",
  {
    room_id: text("room_id").notNull(),
    member: text("member").notNull(),
    wake: integer("wake", { mode: "boolean" }).notNull(),
    joined_at: integer("joined_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.room_id, t.member] })],
);

export const conversationThreads = sqliteTable("threads", {
  id: text("id").primaryKey(),
  room_id: text("room_id").notNull(),
  title: text("title").notNull(),
  created_at: integer("created_at").notNull(),
});

export const messages = sqliteTable("messages", {
  ordinal: integer("ordinal").notNull().unique(),
  id: text("id").primaryKey(),
  room_id: text("room_id").notNull(),
  thread_id: text("thread_id"),
  seq: integer("seq").notNull(),
  author_key: text("author_key").notNull(),
  client_op_id: text("client_op_id").notNull(),
  request_hash: text("request_hash").notNull(),
  message: text("message", { mode: "json" })
    .$type<import("@tila/schemas").Message>()
    .notNull(),
  author_agent: text("author_agent"),
  chain_id: text("chain_id").notNull(),
  hop: integer("hop").notNull(),
  created_at: integer("created_at").notNull(),
});

export const messageRecipients = sqliteTable("message_recipients", {
  ordinal: integer("ordinal").notNull(),
  id: text("id").primaryKey(),
  message_id: text("message_id").notNull(),
  agent_id: text("agent_id").notNull(),
  target_binding_id: text("target_binding_id"),
  target_epoch: integer("target_epoch"),
  state: text("state").notNull().default("pending"),
  fetched_at: integer("fetched_at"),
  fetched_binding_id: text("fetched_binding_id"),
  fetched_epoch: integer("fetched_epoch"),
  acked_at: integer("acked_at"),
  acked_binding_id: text("acked_binding_id"),
  acked_epoch: integer("acked_epoch"),
  disposition: text("disposition"),
  wake_suppressed: text("wake_suppressed"),
  rewakes: integer("rewakes").notNull().default(0),
  created_at: integer("created_at").notNull(),
  expires_at: integer("expires_at").notNull(),
});

export const dispatchOutbox = sqliteTable("dispatch_outbox", {
  agent_id: text("agent_id").primaryKey(),
  state: text("state").notNull().default("pending"),
  publish_gen: integer("publish_gen").notNull().default(0),
  lease_token: text("lease_token"),
  lease_until: integer("lease_until"),
  lease_gen: integer("lease_gen"),
  lease_binding_id: text("lease_binding_id"),
  lease_epoch: integer("lease_epoch"),
  next_attempt_at: integer("next_attempt_at").notNull(),
  attempt_count: integer("attempt_count").notNull().default(0),
  updated_at: integer("updated_at").notNull(),
});

export const dispatchAttempts = sqliteTable("dispatch_attempts", {
  room_ids: text("room_ids", { mode: "json" }).$type<string[]>().notNull(),
  delivery_ids: text("delivery_ids", { mode: "json" })
    .$type<string[]>()
    .notNull(),
  id: text("id").primaryKey(),
  agent_id: text("agent_id").notNull(),
  lease_token: text("lease_token").notNull(),
  consumer_binding_id: text("consumer_binding_id").notNull(),
  binding_epoch: integer("binding_epoch").notNull(),
  publish_gen: integer("publish_gen").notNull(),
  outcome: text("outcome").notNull(),
  created_at: integer("created_at").notNull(),
  reported_at: integer("reported_at"),
});

export const conversationContext = sqliteTable("conversation_context", {
  consumer_binding_id: text("consumer_binding_id").primaryKey(),
  delivery_id: text("delivery_id").notNull(),
  opened_at: integer("opened_at").notNull(),
});

export const conversationState = sqliteTable("_conversation_state", {
  singleton: integer("singleton").primaryKey(),
  generation: text("generation").notNull(),
});
