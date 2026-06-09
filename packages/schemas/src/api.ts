import { z } from "zod";
import {
  ArtifactSearchResultSchema,
  EntitySearchResultSchema,
} from "./artifact";
import { ClaimModeSchema } from "./claim";
import { JournalEventKindSchema } from "./journal";
import { RecordKeySchema, RecordTagSchema, RecordTypeSchema } from "./record";
import {
  EntityRelationshipSchema,
  EntityRelationshipTypeSchema,
} from "./relationship";
import { TagsSchema } from "./tags";

// --- Error envelope ---

export const ErrorEnvelopeSchema = z.object({
  ok: z.literal(false),
  error: z.object({
    code: z.string(),
    message: z.string(),
    retryable: z.boolean(),
    gateIds: z.array(z.string()).optional(),
  }),
});

export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>;

// --- Claim API ---

export const AcquireRequestSchema = z.object({
  resource: z.string(),
  mode: ClaimModeSchema,
  ttl_ms: z.number().int().positive(),
  idempotency_key: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export type AcquireRequest = z.infer<typeof AcquireRequestSchema>;

export const AcquireSuccessResponseSchema = z.object({
  ok: z.literal(true),
  fence: z.number().int(),
  expires_at: z.number().int(),
});

export type AcquireSuccessResponse = z.infer<
  typeof AcquireSuccessResponseSchema
>;

export const RenewRequestSchema = z.object({
  resource: z.string(),
  fence: z.number().int(),
  ttl_ms: z.number().int().positive(),
});

export type RenewRequest = z.infer<typeof RenewRequestSchema>;

export const RenewSuccessResponseSchema = z.object({
  ok: z.literal(true),
  expires_at: z.number().int(),
});

export type RenewSuccessResponse = z.infer<typeof RenewSuccessResponseSchema>;

export const ReleaseRequestSchema = z.object({
  resource: z.string(),
  fence: z.number().int(),
});

export type ReleaseRequest = z.infer<typeof ReleaseRequestSchema>;

export const ReleaseSuccessResponseSchema = z.object({
  ok: z.literal(true),
});

export type ReleaseSuccessResponse = z.infer<
  typeof ReleaseSuccessResponseSchema
>;

// --- State API ---

export const StateResponseSchema = z.object({
  ok: z.literal(true),
  claim: z
    .object({
      resource: z.string(),
      machine: z.string(),
      user: z.string(),
      mode: ClaimModeSchema,
      fence: z.number().int(),
      acquired_at: z.number().int(),
      expires_at: z.number().int(),
      metadata: z.record(z.unknown()).optional(),
    })
    .nullable(),
});

export type StateResponse = z.infer<typeof StateResponseSchema>;

export const StateListResponseSchema = z.object({
  ok: z.literal(true),
  claims: z.array(
    z.object({
      resource: z.string(),
      machine: z.string(),
      user: z.string(),
      mode: ClaimModeSchema,
      fence: z.number().int(),
      acquired_at: z.number().int(),
      expires_at: z.number().int(),
      metadata: z.record(z.unknown()).optional(),
    }),
  ),
});

export type StateListResponse = z.infer<typeof StateListResponseSchema>;

// --- Entity API ---

export const CreateEntityRequestSchema = z.object({
  id: z.string(),
  type: z.string(),
  data: z.record(z.unknown()).default({}),
  tags: TagsSchema.optional(),
});

export type CreateEntityRequest = z.infer<typeof CreateEntityRequestSchema>;

export const UpdateEntityRequestSchema = z.object({
  data: z.record(z.unknown()),
  fence: z.number().int(),
  tags: TagsSchema.optional(),
});

export type UpdateEntityRequest = z.infer<typeof UpdateEntityRequestSchema>;

export const ArchiveRequestSchema = z.object({
  fence: z.number().int(),
});

export type ArchiveRequest = z.infer<typeof ArchiveRequestSchema>;

export const EntityResponseSchema = z.object({
  ok: z.literal(true),
  entity: z.object({
    id: z.string(),
    type: z.string(),
    schema_version: z.number().int(),
    data: z.record(z.unknown()),
    archived: z.number().int(),
    created_at: z.number().int(),
    updated_at: z.number().int(),
    created_by: z.string(),
    tags: z.array(z.string()),
  }),
});

export type EntityResponse = z.infer<typeof EntityResponseSchema>;

export const EntityListResponseSchema = z.object({
  ok: z.literal(true),
  entities: z.array(
    z.object({
      id: z.string(),
      type: z.string(),
      schema_version: z.number().int(),
      data: z.record(z.unknown()),
      archived: z.number().int(),
      created_at: z.number().int(),
      updated_at: z.number().int(),
      created_by: z.string(),
      tags: z.array(z.string()),
    }),
  ),
});

export type EntityListResponse = z.infer<typeof EntityListResponseSchema>;

export const PaginatedEntityListResponseSchema = z.object({
  ok: z.literal(true),
  entities: z.array(
    z.object({
      id: z.string(),
      type: z.string(),
      schema_version: z.number().int(),
      data: z.record(z.unknown()),
      archived: z.number().int(),
      created_at: z.number().int(),
      updated_at: z.number().int(),
      created_by: z.string(),
      tags: z.array(z.string()),
    }),
  ),
  total: z.number().int(),
  limit: z.number().int().nullable(),
  offset: z.number().int(),
  has_more: z.boolean(),
});

export type PaginatedEntityListResponse = z.infer<
  typeof PaginatedEntityListResponseSchema
>;

export const ListReadyEntitiesResponseSchema = z.object({
  ok: z.literal(true),
  entities: z.array(
    z.object({
      id: z.string(),
      type: z.string(),
      schema_version: z.number().int(),
      data: z.record(z.unknown()),
      archived: z.number().int(),
      created_at: z.number().int(),
      updated_at: z.number().int(),
      created_by: z.string(),
    }),
  ),
});

export type ListReadyEntitiesResponse = z.infer<
  typeof ListReadyEntitiesResponseSchema
>;

// --- Compact entity response (for ?compact=true) ---

export const CompactEntitySchema = z.object({
  id: z.string(),
  type: z.string(),
  title: z.string().nullable(),
  status: z.string().nullable(),
  claimed_by: z.string().nullable(),
  blockers: z.number().int().nonnegative(),
  artifacts: z.number().int().nonnegative(),
});
export type CompactEntity = z.infer<typeof CompactEntitySchema>;

export const CompactEntityListResponseSchema = z.object({
  ok: z.literal(true),
  entities: z.array(CompactEntitySchema),
});
export type CompactEntityListResponse = z.infer<
  typeof CompactEntityListResponseSchema
>;

export const CompactEntityResponseSchema = z.object({
  ok: z.literal(true),
  entity: CompactEntitySchema,
});
export type CompactEntityResponse = z.infer<typeof CompactEntityResponseSchema>;

export const PaginatedCompactEntityListResponseSchema = z.object({
  ok: z.literal(true),
  entities: z.array(CompactEntitySchema),
  total: z.number().int(),
  limit: z.number().int().nullable(),
  offset: z.number().int(),
  has_more: z.boolean(),
});

export type PaginatedCompactEntityListResponse = z.infer<
  typeof PaginatedCompactEntityListResponseSchema
>;

// --- Summary response ---

export const SummaryResponseSchema = z.object({
  ok: z.literal(true),
  project: z.object({
    entity_count: z.number().int(),
    entity_counts: z.record(z.number().int()),
    status_counts: z.record(z.number().int()),
    active_claims: z.number().int(),
    ready_count: z.number().int(),
    online_machines: z.array(z.string()),
    token_estimate: z.number().int(),
    recent_events: z.array(
      z.object({
        seq: z.number().int(),
        t: z.number().int(),
        kind: z.string(),
        resource: z.string(),
        actor: z.string(),
      }),
    ),
  }),
});
export type SummaryResponse = z.infer<typeof SummaryResponseSchema>;

export const EntityDetailResponseSchema = z.object({
  ok: z.literal(true),
  entity: z.object({
    id: z.string(),
    type: z.string(),
    schema_version: z.number().int(),
    data: z.record(z.unknown()),
    archived: z.number().int(),
    created_at: z.number().int(),
    updated_at: z.number().int(),
    created_by: z.string(),
    tags: z.array(z.string()),
  }),
  relationships: z.array(EntityRelationshipSchema).default([]),
});

export type EntityDetailResponse = z.infer<typeof EntityDetailResponseSchema>;

export const ArchiveSuccessResponseSchema = z.object({
  ok: z.literal(true),
});

export type ArchiveSuccessResponse = z.infer<
  typeof ArchiveSuccessResponseSchema
>;

// --- Entity Relationship API ---

export const CreateEntityRelationshipRequestSchema = z.object({
  from_id: z.string().min(1),
  to_id: z.string().min(1),
  type: EntityRelationshipTypeSchema,
});

export type CreateEntityRelationshipRequest = z.infer<
  typeof CreateEntityRelationshipRequestSchema
>;

export const CreateEntityRelationshipResponseSchema = z.object({
  ok: z.literal(true),
  created: z.boolean().default(true),
});

export type CreateEntityRelationshipResponse = z.infer<
  typeof CreateEntityRelationshipResponseSchema
>;

// List
export const ListEntityRelationshipsRequestSchema = z.object({
  from_id: z.string().min(1).optional(),
  to_id: z.string().min(1).optional(),
  type: EntityRelationshipTypeSchema.optional(),
});

export type ListEntityRelationshipsRequest = z.infer<
  typeof ListEntityRelationshipsRequestSchema
>;

export const ListEntityRelationshipsResponseSchema = z.object({
  ok: z.literal(true),
  relationships: z.array(EntityRelationshipSchema),
});

export type ListEntityRelationshipsResponse = z.infer<
  typeof ListEntityRelationshipsResponseSchema
>;

// Delete
export const DeleteEntityRelationshipRequestSchema = z.object({
  from_id: z.string().min(1),
  to_id: z.string().min(1),
  type: EntityRelationshipTypeSchema,
});

export type DeleteEntityRelationshipRequest = z.infer<
  typeof DeleteEntityRelationshipRequestSchema
>;

export const DeleteEntityRelationshipResponseSchema = z.object({
  ok: z.literal(true),
  removed: z.boolean(),
});

export type DeleteEntityRelationshipResponse = z.infer<
  typeof DeleteEntityRelationshipResponseSchema
>;

// --- Journal API ---

export const JournalQuerySchema = z.object({
  resource: z.string().optional(),
  kind: JournalEventKindSchema.optional(),
  source: z.string().optional(),
  after_seq: z.number().int().optional(),
  limit: z.number().int().positive().default(100),
});

export type JournalQuery = z.infer<typeof JournalQuerySchema>;

export const JournalResponseSchema = z.object({
  ok: z.literal(true),
  events: z.array(
    z.object({
      seq: z.number().int(),
      t: z.number().int(),
      kind: z.string(),
      resource: z.string(),
      actor: z.string(),
      token_id: z.string().nullable(),
      fence: z.number().int().nullable(),
      data: z.record(z.unknown()),
      source: z.string().nullable(),
      source_version: z.string().nullable(),
    }),
  ),
});

export type JournalResponse = z.infer<typeof JournalResponseSchema>;

// --- Presence API ---

export const PresenceHeartbeatRequestSchema = z.object({
  machine: z.string(),
  info: z.record(z.unknown()).default({}),
});

export type PresenceHeartbeatRequest = z.infer<
  typeof PresenceHeartbeatRequestSchema
>;

export const PresenceListResponseSchema = z.object({
  ok: z.literal(true),
  machines: z.array(
    z.object({
      machine: z.string(),
      last_seen: z.number().int(),
      info: z.record(z.unknown()),
    }),
  ),
});

export type PresenceListResponse = z.infer<typeof PresenceListResponseSchema>;

export const PresenceAllListResponseSchema = z.object({
  ok: z.literal(true),
  machines: z.array(
    z.object({
      machine: z.string(),
      last_seen: z.number().int(),
      info: z.record(z.unknown()),
      active: z.boolean(),
    }),
  ),
});

export type PresenceAllListResponse = z.infer<
  typeof PresenceAllListResponseSchema
>;

export const PresenceHeartbeatSuccessResponseSchema = z.object({
  ok: z.literal(true),
});

export type PresenceHeartbeatSuccessResponse = z.infer<
  typeof PresenceHeartbeatSuccessResponseSchema
>;

// --- Health API ---

export const HealthResponseSchema = z.object({
  ok: z.literal(true),
  version: z.string(),
  apiVersion: z.number().int(),
  minCliVersion: z.string(),
  project_id: z.string().optional(),
});

export type HealthResponse = z.infer<typeof HealthResponseSchema>;

// --- Whoami API ---

export const WhoamiResponseSchema = z.object({
  ok: z.literal(true),
  project_id: z.string(),
  token_name: z.string(),
  scopes: z.string(),
  auth_kind: z.enum(["d1-token", "session", "cookie-session"]).optional(),
  github_login: z.string().optional(),
  permission: z.string().optional(),
  expires_at: z.number().optional(),
});

export type WhoamiResponse = z.infer<typeof WhoamiResponseSchema>;

// --- DO Health API (doctor probe) ---

export const DOHealthResponseSchema = z.object({
  ok: z.literal(true),
  expiredClaimsCount: z.number(),
  journalRows: z.number(),
  maxSeq: z.number(),
});

export type DOHealthResponse = z.infer<typeof DOHealthResponseSchema>;

// --- Doctor Probe API ---

export const DoctorProbeResponseSchema = z.object({
  ok: z.literal(true),
  doRttMs: z.number(),
  doHealth: DOHealthResponseSchema,
  r2Reachable: z.boolean(),
});

export type DoctorProbeResponse = z.infer<typeof DoctorProbeResponseSchema>;

// --- Doctor Schema API ---

export const SqliteColumnInfoSchema = z.object({
  cid: z.number(),
  name: z.string(),
  type: z.string(),
  notnull: z.number(),
  dflt_value: z.string().nullable(),
  pk: z.number(),
});

export type SqliteColumnInfo = z.infer<typeof SqliteColumnInfoSchema>;

export const SchemaMigrationRecordSchema = z.object({
  version: z.number(),
  applied_at: z.number(),
});

export type SchemaMigrationRecord = z.infer<typeof SchemaMigrationRecordSchema>;

export const DoctorSchemaSuccessResponseSchema = z.object({
  ok: z.literal(true),
  do_code_version: z.string().optional(),
  sqlite_version: z.string(),
  migrations: z.array(SchemaMigrationRecordSchema),
  tables: z.array(z.string()),
  columns: z.record(z.array(SqliteColumnInfoSchema)),
  claims_columns: z.array(SqliteColumnInfoSchema).optional(),
});

export type DoctorSchemaSuccessResponse = z.infer<
  typeof DoctorSchemaSuccessResponseSchema
>;

export const DoctorSchemaStaleResponseSchema = z.object({
  ok: z.literal(true),
  stale_do: z.literal(true),
  message: z.string(),
  probe_result: z.unknown(),
});

export type DoctorSchemaStaleResponse = z.infer<
  typeof DoctorSchemaStaleResponseSchema
>;

export const DoctorSchemaResponseSchema = z.union([
  DoctorSchemaSuccessResponseSchema,
  DoctorSchemaStaleResponseSchema,
]);

export type DoctorSchemaResponse = z.infer<typeof DoctorSchemaResponseSchema>;

// --- Search Drift API (doctor search-drift) ---

export const SearchDriftCheckNameSchema = z.enum([
  "search-missing-doc",
  "search-orphan-doc",
  "search-tombstone-leak",
  "search-unsupported-kind",
  "search-stale-index",
]);

export const SearchDriftFindingSchema = z.object({
  check: SearchDriftCheckNameSchema,
  status: z.enum(["pass", "warn", "fail"]),
  count: z.number().int().nonnegative(),
  detail: z.string(),
  examples: z.array(z.string()).max(5),
});

export const SearchDriftReportSchema = z.object({
  ok: z.literal(true),
  findings: z.array(SearchDriftFindingSchema),
  checkedAt: z.number().int(),
});

export type SearchDriftReport = z.infer<typeof SearchDriftReportSchema>;
export type SearchDriftFinding = z.infer<typeof SearchDriftFindingSchema>;
export type SearchDriftCheckName = z.infer<typeof SearchDriftCheckNameSchema>;

// --- Token Management API ---

export const TokenIssueRequestSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9-]+$/),
  note: z.string().max(256).optional(),
});

export type TokenIssueRequest = z.infer<typeof TokenIssueRequestSchema>;

export const TokenIssueResponseSchema = z.object({
  ok: z.literal(true),
  token: z.string(),
  name: z.string(),
  created_at: z.number().int(),
});

export type TokenIssueResponse = z.infer<typeof TokenIssueResponseSchema>;

export const TokenRevokeResponseSchema = z.object({
  ok: z.literal(true),
  name: z.string(),
  revoked_at: z.number().int(),
});

export type TokenRevokeResponse = z.infer<typeof TokenRevokeResponseSchema>;

export const TokenListItemSchema = z.object({
  name: z.string(),
  note: z.string().nullable(),
  scopes: z.string(),
  created_at: z.number().int(),
  created_by: z.string(),
  last_used_at: z.number().int().nullable(),
  revoked_at: z.number().int().nullable(),
  revoked_by: z.string().nullable(),
});

export type TokenListItem = z.infer<typeof TokenListItemSchema>;

export const TokenListResponseSchema = z.object({
  ok: z.literal(true),
  tokens: z.array(TokenListItemSchema),
});

export type TokenListResponse = z.infer<typeof TokenListResponseSchema>;

// --- Reconcile API ---

export const ReconcileDetailSchema = z.object({
  key: z.string(),
  status: z.enum(["recovered", "skipped", "unrecoverable"]),
  reason: z.string().optional(),
});

export type ReconcileDetail = z.infer<typeof ReconcileDetailSchema>;

export const ReconcileReportSchema = z.object({
  ok: z.literal(true),
  orphans_found: z.number().int(),
  orphans_recovered: z.number().int(),
  orphans_unrecoverable: z.number().int(),
  details: z.array(ReconcileDetailSchema),
});

export type ReconcileReport = z.infer<typeof ReconcileReportSchema>;

// --- Search Rebuild API ---

export const SearchRebuildDetailSchema = z.object({
  artifact_key: z.string(),
  status: z.enum(["written", "tombstoned", "skipped", "unrecoverable"]),
  reason: z.string().optional(),
});

export type SearchRebuildDetail = z.infer<typeof SearchRebuildDetailSchema>;

export const SearchRebuildReportSchema = z.object({
  ok: z.literal(true),
  candidates_found: z.number().int(),
  written: z.number().int(),
  tombstoned: z.number().int(),
  skipped: z.number().int(),
  unrecoverable: z.number().int(),
  details: z.array(SearchRebuildDetailSchema),
});

export type SearchRebuildReport = z.infer<typeof SearchRebuildReportSchema>;

// --- Entity-Artifact Reference API ---

export const AddEntityArtifactReferenceRequestSchema = z.object({
  artifact_key: z.string().min(1),
  slot: z.string().min(1),
  metadata: z.record(z.unknown()).default({}),
});

export type AddEntityArtifactReferenceRequest = z.infer<
  typeof AddEntityArtifactReferenceRequestSchema
>;

export const EntityArtifactReferenceListResponseSchema = z.object({
  ok: z.literal(true),
  references: z.array(
    z.object({
      entity_id: z.string(),
      artifact_key: z.string(),
      slot: z.string(),
      metadata: z.record(z.unknown()),
      created_at: z.number().int(),
    }),
  ),
});

export type EntityArtifactReferenceListResponse = z.infer<
  typeof EntityArtifactReferenceListResponseSchema
>;

// --- Artifact Search API ---

export const ArtifactSearchResponseSchema = z.object({
  ok: z.literal(true),
  results: z.array(ArtifactSearchResultSchema),
  total: z.number().int(),
});

export type ArtifactSearchResponse = z.infer<
  typeof ArtifactSearchResponseSchema
>;

// --- Artifact Search Query ---

export const ArtifactSearchQuerySchema = z.object({
  q: z.string().min(1).max(200),
  kind: z.string().optional(),
  resource: z.string().optional(),
  source_only: z
    .string()
    .optional()
    .transform((v) => v === "true")
    .pipe(z.boolean()),
  limit: z
    .string()
    .optional()
    .default("20")
    .transform((v) => Number.parseInt(v, 10))
    .pipe(z.number().int().min(1).max(100)),
});

export type ArtifactSearchQuery = z.infer<typeof ArtifactSearchQuerySchema>;

// --- Artifact Grep API ---

export const ArtifactGrepLineSchema = z.object({
  line: z.number().int(), // 1-based line number
  text: z.string(), // matching line, truncated to GREP_MAX_LINE_TEXT chars
  col: z.number().int(), // 1-based column of first match in the line
});

export const ArtifactGrepResultSchema = z.object({
  key: z.string(),
  kind: z.string(),
  resource: z.string().nullable(),
  lines: z.array(ArtifactGrepLineSchema),
  truncated: z.boolean().optional(), // this blob hit the per-blob byte cap
});

export const ArtifactGrepResponseSchema = z.object({
  ok: z.literal(true),
  results: z.array(ArtifactGrepResultSchema),
  scanned: z.number().int(), // candidates actually scanned
  skipped: z.number().int(), // candidates skipped (blob missing/expired)
  truncated: z.boolean(), // request-level cap hit (candidate/byte/match cap)
});

export type ArtifactGrepResponse = z.infer<typeof ArtifactGrepResponseSchema>;

export const ArtifactGrepQuerySchema = z.object({
  pattern: z.string().min(1).max(200),
  kind: z.string().optional(),
  resource: z.string().optional(),
  regex: z
    .string()
    .optional()
    .default("false")
    .transform((v) => v === "true")
    .pipe(z.boolean()),
  limit: z
    .string()
    .optional()
    .default("50")
    .transform((v) => Number.parseInt(v, 10))
    .pipe(z.number().int().min(1).max(100)), // candidate cap, hard ceiling SWEEP_BATCH_SIZE
});

export type ArtifactGrepQuery = z.infer<typeof ArtifactGrepQuerySchema>;

// --- Record Search API ---

export const RecordSearchResultSchema = z.object({
  record_type: z.string(),
  record_key: z.string(),
  snippet: z.string().nullable(),
  indexed_at: z.number().int(),
});

export type RecordSearchResult = z.infer<typeof RecordSearchResultSchema>;

// --- Unified Search API ---

export const UnifiedSearchResultSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("entity") }).merge(EntitySearchResultSchema),
  z.object({ type: z.literal("artifact") }).merge(ArtifactSearchResultSchema),
  z.object({ type: z.literal("record") }).merge(RecordSearchResultSchema),
]);

export type UnifiedSearchResult = z.infer<typeof UnifiedSearchResultSchema>;

export const UnifiedSearchResponseSchema = z.object({
  ok: z.literal(true),
  results: z.array(UnifiedSearchResultSchema),
  total: z.number().int(),
});

export type UnifiedSearchResponse = z.infer<typeof UnifiedSearchResponseSchema>;

export const UnifiedSearchQuerySchema = z.object({
  q: z.string().min(1).max(200),
  limit: z
    .string()
    .optional()
    .default("20")
    .transform((v) => Number.parseInt(v, 10))
    .pipe(z.number().int().min(1).max(100)),
});

export type UnifiedSearchQuery = z.infer<typeof UnifiedSearchQuerySchema>;

// --- Artifact response schemas (promoted from CLI) ---

export const ArtifactTextWriteRequestSchema = z.object({
  content: z.string().min(1),
  kind: z.string().min(1),
  mime_type: z.string().default("text/markdown"),
  resource: z.string().optional(),
  fence: z.number().int().optional(),
  tags: TagsSchema.optional(),
});
export type ArtifactTextWriteRequest = z.infer<
  typeof ArtifactTextWriteRequestSchema
>;

export const ArtifactPutResponseSchema = z.object({
  ok: z.literal(true),
  key: z.string(),
  bytes: z.number(),
  deduplicated: z.boolean(),
});
export type ArtifactPutResponse = z.infer<typeof ArtifactPutResponseSchema>;

export const ArtifactListResponseSchema = z.object({
  ok: z.literal(true),
  pointers: z.array(
    z.object({
      r2_key: z.string(),
      resource: z.string().nullable(),
      kind: z.string(),
      sha256: z.string(),
      bytes: z.number(),
      fence: z.number().nullable(),
      mime_type: z.string(),
      produced_at: z.number(),
      produced_by: z.string(),
      expires_at: z.number().nullable(),
      tombstoned: z.number(),
      tags: z.array(z.string()),
    }),
  ),
});
export type ArtifactListResponse = z.infer<typeof ArtifactListResponseSchema>;

export const ArtifactRelationshipOkResponseSchema = z.object({
  ok: z.literal(true),
});
export type ArtifactRelationshipOkResponse = z.infer<
  typeof ArtifactRelationshipOkResponseSchema
>;

export const ArtifactRelationshipListResponseSchema = z.object({
  ok: z.literal(true),
  relationships: z.array(
    z.object({
      from_key: z.string(),
      to_key: z.string().nullable(),
      to_uri: z.string().nullable(),
      type: z.string(),
      metadata: z.record(z.unknown()),
      created_at: z.number(),
    }),
  ),
});
export type ArtifactRelationshipListResponse = z.infer<
  typeof ArtifactRelationshipListResponseSchema
>;

// --- Template API ---

export const InstantiateTemplateRequestSchema = z.object({
  template_name: z.string(),
  root_id: z.string(),
  vars: z.record(z.string()).default({}),
});
export type InstantiateTemplateRequest = z.infer<
  typeof InstantiateTemplateRequestSchema
>;

export const InstantiateTemplateResponseSchema = z.object({
  ok: z.literal(true),
  created_entities: z.array(z.string()),
  created_relationships: z.number().int(),
  journal_seq: z.number().int(),
});
export type InstantiateTemplateResponse = z.infer<
  typeof InstantiateTemplateResponseSchema
>;

// --- Repo Allowlist API ---

export const RepoRegisterRequestSchema = z.object({
  owner: z.string().min(1).max(100),
  repo: z.string().min(1).max(100),
  github_host: z.string().optional().default("github.com"),
  github_token: z.string().optional(),
  min_read_permission: z.string().optional(),
  min_write_permission: z.string().optional(),
});
export type RepoRegisterRequest = z.infer<typeof RepoRegisterRequestSchema>;

export const RepoRegisterResponseSchema = z.object({
  ok: z.literal(true),
  github_repo_id: z.number().int(),
  full_name: z.string(),
  registered_at: z.number().int(),
});
export type RepoRegisterResponse = z.infer<typeof RepoRegisterResponseSchema>;

export const RepoDeleteResponseSchema = z.object({
  ok: z.literal(true),
  github_repo_id: z.number().int(),
  removed_at: z.number().int(),
});
export type RepoDeleteResponse = z.infer<typeof RepoDeleteResponseSchema>;

// --- Record API ---

export const RecordCreateRequestSchema = z.object({
  key: RecordKeySchema,
  value: z.record(z.unknown()),
  tags: RecordTagSchema.optional(),
  message: z.string().optional(),
  source_artifact_key: z.string().nullable().optional(),
});

export type RecordCreateRequest = z.infer<typeof RecordCreateRequestSchema>;

export const RecordSetRequestSchema = z.object({
  value: z.record(z.unknown()),
  fence: z.number().int(),
  tags: RecordTagSchema.optional(),
  message: z.string().optional(),
  source_artifact_key: z.string().nullable().optional(),
});

export type RecordSetRequest = z.infer<typeof RecordSetRequestSchema>;

export const RecordPatchRequestSchema = z.object({
  patch: z.record(z.unknown()),
  fence: z.number().int(),
  message: z.string().optional(),
});

export type RecordPatchRequest = z.infer<typeof RecordPatchRequestSchema>;

export const RecordArchiveRequestSchema = z.object({
  fence: z.number().int(),
  message: z.string().optional(),
});

export type RecordArchiveRequest = z.infer<typeof RecordArchiveRequestSchema>;

export const RecordUnarchiveRequestSchema = z.object({
  fence: z.number().int(),
  message: z.string().optional(),
});

export type RecordUnarchiveRequest = z.infer<
  typeof RecordUnarchiveRequestSchema
>;

export const RecordItemSchema = z.object({
  type: RecordTypeSchema,
  key: RecordKeySchema,
  schema_version: z.number().int(),
  value: z.record(z.unknown()),
  value_sha256: z.string(),
  revision: z.number().int(),
  archived: z.number().int(),
  created_at: z.number().int(),
  updated_at: z.number().int(),
  updated_by: z.string(),
  tags: z.array(z.string()),
});

export type RecordItem = z.infer<typeof RecordItemSchema>;

export const RecordGetResponseSchema = z.object({
  ok: z.literal(true),
  record: RecordItemSchema,
  fence: z.number().int(),
});

export type RecordGetResponse = z.infer<typeof RecordGetResponseSchema>;

export const RecordMutateResponseSchema = z.object({
  ok: z.literal(true),
  record: RecordItemSchema,
  fence: z.number().int(),
  revision: z.number().int(),
});

export type RecordMutateResponse = z.infer<typeof RecordMutateResponseSchema>;

export const RecordListItemSchema = z.object({
  type: RecordTypeSchema,
  key: RecordKeySchema,
  revision: z.number().int(),
  updated_at: z.number().int(),
  updated_by: z.string(),
  archived: z.number().int(),
  tags: z.array(z.string()),
});

export type RecordListItem = z.infer<typeof RecordListItemSchema>;

export const RecordListResponseSchema = z.object({
  ok: z.literal(true),
  items: z.array(RecordListItemSchema),
  meta: z.object({
    total: z.number().int(),
    limit: z.number().int(),
    next_cursor: z.string().nullable(),
  }),
});

export type RecordListResponse = z.infer<typeof RecordListResponseSchema>;

export const RecordHistoryItemSchema = z.object({
  type: RecordTypeSchema,
  key: RecordKeySchema,
  revision: z.number().int(),
  operation: z.enum(["created", "set", "patch", "archived", "unarchived"]),
  schema_version: z.number().int(),
  value_sha256: z.string(),
  canonical_artifact_key: z.string().nullable(),
  source_artifact_key: z.string().nullable(),
  actor: z.string(),
  created_at: z.number().int(),
  message: z.string().nullable(),
});

export type RecordHistoryItem = z.infer<typeof RecordHistoryItemSchema>;

export const RecordHistoryResponseSchema = z.object({
  ok: z.literal(true),
  items: z.array(RecordHistoryItemSchema),
  meta: z.object({
    total: z.number().int(),
    limit: z.number().int(),
    next_cursor: z.string().nullable(),
  }),
});

export type RecordHistoryResponse = z.infer<typeof RecordHistoryResponseSchema>;

export const RecordTypesResponseSchema = z.object({
  ok: z.literal(true),
  types: z.array(z.string()),
});

export type RecordTypesResponse = z.infer<typeof RecordTypesResponseSchema>;
