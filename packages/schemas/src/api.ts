import { z } from "zod";
import {
  ArtifactSearchResultSchema,
  EntitySearchResultSchema,
} from "./artifact";
import { ArtifactTrustFieldsSchema } from "./artifact-review";
import { ArtifactRevisionSchema } from "./artifact-version";
import {
  CredentialPolicyReadSchema,
  CredentialPolicySchema,
} from "./capability";
import {
  CatalogIncompleteSchema,
  RecordCatalogEntrySchema,
  ResultScopeSchema,
  TaskListScopeSchema,
} from "./catalog";
import { ClaimModeSchema } from "./claim";
import { LIFECYCLE_OUTCOMES, LifecycleOutcomeSchema } from "./config";
import { EnvironmentMetadataSchema, ParticipantIdSchema } from "./identity";
import { JournalEventKindSchema } from "./journal";
import {
  MembershipSourceSchema,
  ProjectMembershipSchema,
  ProjectRoleSchema,
} from "./membership";
import { RecordKeySchema, RecordTagSchema, RecordTypeSchema } from "./record";
import {
  EntityRelationshipSchema,
  EntityRelationshipTypeSchema,
} from "./relationship";
import { SessionPermissionSchema } from "./session";
import { TagSchema, TagsSchema } from "./tags";

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

// --- Project membership API ---

export const MembershipGrantResponseSchema = z.object({
  ok: z.literal(true),
  membership: ProjectMembershipSchema,
  created: z.boolean(),
});
export type MembershipGrantResponse = z.infer<
  typeof MembershipGrantResponseSchema
>;

// --- Claim API ---

export const AcquireRequestSchema = z.object({
  resource: z.string(),
  mode: ClaimModeSchema,
  ttl_ms: z.number().int().positive(),
  idempotency_key: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type AcquireRequest = z.infer<typeof AcquireRequestSchema>;

export const AcquireSuccessResponseSchema = z.object({
  ok: z.literal(true),
  fence: z.number().int(),
  expires_at: z.number().int(),
  participant_id: ParticipantIdSchema,
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
      principal_id: z.string(),
      participant_id: ParticipantIdSchema,
      environment: EnvironmentMetadataSchema,
      mode: ClaimModeSchema,
      fence: z.number().int(),
      acquired_at: z.number().int(),
      expires_at: z.number().int(),
      metadata: z.record(z.string(), z.unknown()).optional(),
    })
    .nullable(),
});

export type StateResponse = z.infer<typeof StateResponseSchema>;

export const StateListResponseSchema = z.object({
  ok: z.literal(true),
  claims: z.array(
    z.object({
      resource: z.string(),
      principal_id: z.string(),
      participant_id: ParticipantIdSchema,
      environment: EnvironmentMetadataSchema,
      mode: ClaimModeSchema,
      fence: z.number().int(),
      acquired_at: z.number().int(),
      expires_at: z.number().int(),
      metadata: z.record(z.string(), z.unknown()).optional(),
    }),
  ),
});

export type StateListResponse = z.infer<typeof StateListResponseSchema>;

// --- Entity API ---

export const CreateEntityRequestSchema = z.object({
  id: z.string(),
  type: z.string(),
  data: z.record(z.string(), z.unknown()).default({}),
  tags: TagsSchema.optional(),
});

export type CreateEntityRequest = z.infer<typeof CreateEntityRequestSchema>;

export const UpdateEntityRequestSchema = z.object({
  data: z.record(z.string(), z.unknown()),
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
    data: z.record(z.string(), z.unknown()),
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
      data: z.record(z.string(), z.unknown()),
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
      data: z.record(z.string(), z.unknown()),
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
  /** Opaque keyset cursor for the next page, or null on the last page. */
  next_cursor: z.string().nullable().optional(),
  scope: TaskListScopeSchema.optional(),
});

export type PaginatedEntityListResponse = z.infer<
  typeof PaginatedEntityListResponseSchema
>;

/** Opaque pagination cursor. Bound to the filter and sort it was issued for. */
export const ListCursorSchema = z.string().min(1).max(2048);

export const TASK_LIST_SORTS = [
  "created_at",
  "updated_at",
  "type",
  "title",
  "status",
  "id",
] as const;

/** Numeric paging contract shared by HTTP and embedded task lists. */
export const TaskListPageOptionsSchema = z
  .object({
    limit: z
      .number()
      .int()
      .positive()
      .transform((value) => Math.min(value, 500))
      .optional(),
    offset: z.number().int().nonnegative().optional(),
    cursor: ListCursorSchema.optional(),
    sort: z.enum(TASK_LIST_SORTS).optional(),
    order: z.enum(["asc", "desc"]).optional(),
  })
  .refine((q) => !(q.cursor && q.offset), {
    message: "cursor and offset cannot be combined",
    path: ["cursor"],
  });
export type TaskListPageOptions = z.infer<typeof TaskListPageOptionsSchema>;

/**
 * Query validation for `GET /tasks`. Only the paging contract is strict;
 * filter params stay lenient strings so existing callers keep working.
 */
export const TaskListQuerySchema = z
  .object({
    cursor: ListCursorSchema.optional(),
    limit: z
      .string()
      .regex(/^\d+$/, "limit must be a positive integer")
      .refine(
        (value) => Number.isSafeInteger(Number(value)) && Number(value) > 0,
        "limit must be a positive safe integer",
      )
      .optional(),
    offset: z
      .string()
      .regex(/^\d+$/, "offset must be a non-negative integer")
      .refine(
        (value) => Number.isSafeInteger(Number(value)),
        "offset must be a non-negative safe integer",
      )
      .optional(),
    sort: z.enum(TASK_LIST_SORTS).optional(),
    order: z.enum(["asc", "desc"]).optional(),
    /** `1`: only open tasks with an unresolved, missing or cyclic prerequisite. */
    blocked: z.literal("1").optional(),
    /** Comma list: tasks in the state their type's lifecycle names for it. */
    outcome: z
      .string()
      .refine(
        (value) =>
          value
            .split(",")
            .every(
              (outcome) => LifecycleOutcomeSchema.safeParse(outcome).success,
            ),
        { message: `outcome must list ${LIFECYCLE_OUTCOMES.join(", ")}` },
      )
      .optional(),
  })
  .refine((q) => !(q.cursor && q.offset && q.offset !== "0"), {
    message: "cursor and offset cannot be combined",
    path: ["cursor"],
  });
export type TaskListQuery = z.infer<typeof TaskListQuerySchema>;

export const ListReadyEntitiesResponseSchema = z.object({
  ok: z.literal(true),
  entities: z.array(
    z.object({
      id: z.string(),
      type: z.string(),
      schema_version: z.number().int(),
      data: z.record(z.string(), z.unknown()),
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
  next_cursor: z.string().nullable().optional(),
  scope: TaskListScopeSchema.optional(),
});

export type PaginatedCompactEntityListResponse = z.infer<
  typeof PaginatedCompactEntityListResponseSchema
>;

// --- Summary response ---

export const SummaryResponseSchema = z.object({
  ok: z.literal(true),
  project: z.object({
    entity_count: z.number().int(),
    entity_counts: z.record(z.string(), z.number().int()),
    status_counts: z.record(z.string(), z.number().int()),
    active_claims: z.number().int(),
    ready_count: z.number().int(),
    online_participants: z.array(ParticipantIdSchema),
    token_estimate: z.number().int(),
    recent_events: z.array(
      z.object({
        seq: z.number().int(),
        t: z.number().int(),
        kind: z.string(),
        resource: z.string(),
        principal_id: z.string(),
        participant_id: ParticipantIdSchema,
        environment: EnvironmentMetadataSchema,
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
    data: z.record(z.string(), z.unknown()),
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
  client_name: z.string().optional(),
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
      principal_id: z.string(),
      participant_id: ParticipantIdSchema,
      environment: EnvironmentMetadataSchema,
      token_id: z.string().nullable(),
      fence: z.number().int().nullable(),
      data: z.record(z.string(), z.unknown()),
    }),
  ),
  /**
   * Set by the Worker's journal list. `true` when the `after_seq` cursor sits
   * below the archive watermark: those events were moved to cold storage, so an
   * empty `events` means "archived" (read it with replay), not "caught up".
   * Optional because the embedded and local backends and older Workers omit it.
   */
  archived: z.boolean().optional(),
  /**
   * Highest archived `seq`, or `null` before any archival. Same range and
   * optionality as the other journal sequence numbers (`JournalSequenceSchema`,
   * which cannot be imported here without a cycle).
   */
  lastArchivedSeq: z.number().int().nonnegative().safe().nullable().optional(),
});

export type JournalResponse = z.infer<typeof JournalResponseSchema>;

// --- Presence API ---

export const PresenceHeartbeatRequestSchema = z.object({
  info: z.record(z.string(), z.unknown()).default({}),
});

export type PresenceHeartbeatRequest = z.infer<
  typeof PresenceHeartbeatRequestSchema
>;

export const PresenceListResponseSchema = z.object({
  ok: z.literal(true),
  participants: z.array(
    z.object({
      principal_id: z.string(),
      participant_id: ParticipantIdSchema,
      environment: EnvironmentMetadataSchema,
      last_seen: z.number().int(),
      info: z.record(z.string(), z.unknown()),
    }),
  ),
});

export type PresenceListResponse = z.infer<typeof PresenceListResponseSchema>;

export const PresenceAllListResponseSchema = z.object({
  ok: z.literal(true),
  participants: z.array(
    z.object({
      principal_id: z.string(),
      participant_id: ParticipantIdSchema,
      environment: EnvironmentMetadataSchema,
      last_seen: z.number().int(),
      info: z.record(z.string(), z.unknown()),
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
  /** Product release version of the deployed build. */
  version: z.string(),
  /** Source commit of the deployed build; absent on older Workers. */
  commit: z.string().optional(),
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
  auth_kind: z
    .enum([
      "d1-token",
      "session",
      "cookie-session",
      "workspace-session",
      "oidc-session",
      "github-actions-session",
    ])
    .optional(),
  principal_id: z.string().optional(),
  token_id: z.string().optional(),
  credential_id: z.string().optional(),
  role: ProjectRoleSchema.optional(),
  /** Role from the explicit membership row, when one exists. */
  explicit_role: ProjectRoleSchema.optional(),
  membership_sources: z.array(MembershipSourceSchema).optional(),
  /** GitHub repository id the mirrored role was derived from, when applicable. */
  mirrored_repo_id: z.number().int().optional(),
  policy: CredentialPolicyReadSchema.optional(),
  legacy: z.boolean().optional(),
  github_login: z.string().optional(),
  permission: z.string().optional(),
  expires_at: z.number().nullable().optional(),
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

// --- Admin Store Counts API ---

export const StoreCountsResponseSchema = z.object({
  counts: z.object({
    domain: z.record(z.string(), z.number().int().nonnegative()),
    schemaHistory: z.number().int().nonnegative(),
  }),
  // Older deployments expose row counts only.
  db_bytes: z.number().int().nonnegative().nullable().default(null),
});

export type StoreCountsResponse = z.infer<typeof StoreCountsResponseSchema>;

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
  columns: z.record(z.string(), z.array(SqliteColumnInfoSchema)),
  claims_columns: z.array(SqliteColumnInfoSchema).optional(),
});

export type DoctorSchemaSuccessResponse = z.infer<
  typeof DoctorSchemaSuccessResponseSchema
>;

export const DoctorSchemaStaleResponseSchema = z.object({
  ok: z.literal(true),
  stale_do: z.literal(true),
  message: z.string(),
  probe_result: z.unknown().optional(),
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
  principal_id: z
    .string()
    .regex(/^service:[0-9a-f-]{36}$/)
    .optional(),
  policy: CredentialPolicySchema.optional(),
  expires_at: z.number().int().positive().nullable().optional(),
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9-]+$/),
  note: z.string().max(256).optional(),
  /**
   * Optional DPoP JWK thumbprint (RFC 7638, SHA-256, unpadded base64url — always
   * exactly 43 characters for P-256 keys). When present, the issued token will be
   * sender-constrained: the bearer must present a valid DPoP proof on every request.
   * A malformed thumbprint permanently locks the token (no recovery except reissue),
   * so we validate the format strictly at issue time.
   */
  jkt: z
    .string()
    .regex(/^[A-Za-z0-9_-]{43}$/)
    .optional(),
});

export type TokenIssueRequest = z.infer<typeof TokenIssueRequestSchema>;

export const TokenIssueResponseSchema = z.object({
  token_id: z.string().optional(),
  credential_id: z.string().optional(),
  principal_id: z.string().optional(),
  policy: CredentialPolicyReadSchema.optional(),
  expires_at: z.number().int().nullable().optional(),
  legacy: z.boolean().optional(),
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
  token_id: z.string().optional(),
  credential_id: z.string().optional(),
  principal_id: z.string().optional(),
  policy: CredentialPolicyReadSchema.optional(),
  effective_policy: CredentialPolicyReadSchema.nullable().optional(),
  status: z.enum(["active", "revoked", "expired", "disabled"]).optional(),
  expires_at: z.number().int().nullable().optional(),
  legacy: z.boolean().optional(),
  versions: z
    .array(
      z.object({
        token_id: z.string(),
        expires_at: z.number().int().nullable(),
        retire_at: z.number().int().nullable(),
        revoked_at: z.number().int().nullable(),
      }),
    )
    .optional(),
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
  metadata: z.record(z.string(), z.unknown()).default({}),
});

export type AddEntityArtifactReferenceRequest = z.infer<
  typeof AddEntityArtifactReferenceRequestSchema
>;

export const EntityArtifactReferenceListResponseSchema = z.object({
  ok: z.literal(true),
  references: z.array(
    ArtifactTrustFieldsSchema.extend({
      entity_id: z.string(),
      artifact_key: z.string(),
      slot: z.string(),
      metadata: z.record(z.string(), z.unknown()),
      created_at: z.number().int(),
    }),
  ),
});

export type EntityArtifactReferenceListResponse = z.infer<
  typeof EntityArtifactReferenceListResponseSchema
>;

// --- tag_filter query parsing ---

/**
 * Parse a raw comma-separated `tag_filter` query-string value into a validated,
 * normalized (lowercase, deduped, max-20) array of tags.
 *
 * - Empty / absent input → `undefined` (no filter)
 * - Invalid tag grammar  → throws `ZodError`
 * - More than 20 unique tags → throws `ZodError`
 */
export function parseTagFilter(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;

  const parts = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);

  if (parts.length === 0) return undefined;

  // Validate each lowercased tag against the grammar (TagSchema accepts both
  // upper and lower; we pass the already-lowercased value so it validates cleanly).
  for (const part of parts) {
    TagSchema.parse(part);
  }

  // Deduplicate
  const unique = [...new Set(parts)];

  if (unique.length > 20) {
    throw new z.ZodRealError([
      {
        code: "too_big",
        maximum: 20,
        origin: "array",
        inclusive: true,
        message: "tag_filter may not have more than 20 tags",
        path: ["tag_filter"],
      },
    ]);
  }

  return unique;
}

/**
 * Zod field for a `tag_filter` query parameter.
 * Accepts an optional string, transforms it via `parseTagFilter`.
 * Uses superRefine + transform so that ZodErrors from parseTagFilter are
 * reported via ctx.addIssue rather than thrown (thrown ZodErrors escape
 * safeParse).
 */
export const tagFilterQueryParam = z
  .string()
  .optional()
  .superRefine((v, ctx) => {
    if (!v) return;
    try {
      parseTagFilter(v);
    } catch (err) {
      if (err instanceof z.ZodError) {
        for (const issue of err.issues) {
          ctx.addIssue({
            code: "custom",
            message: issue.message,
            path: issue.path,
          });
        }
      } else {
        throw err;
      }
    }
  })
  .transform((v) => parseTagFilter(v));

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
  tag_filter: tagFilterQueryParam,
});

export type ArtifactSearchQuery = z.infer<typeof ArtifactSearchQuerySchema>;

// --- Artifact Grep API ---

export const ArtifactGrepLineSchema = z.object({
  line: z.number().int(), // 1-based line number
  text: z.string(), // matching line, truncated to GREP_MAX_LINE_TEXT chars
  col: z.number().int(), // 1-based column of first match in the line
});

export const ArtifactGrepResultSchema = ArtifactTrustFieldsSchema.extend({
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
    .pipe(z.number().int().min(1).max(100)), // candidate cap, hard ceiling GREP_CANDIDATE_CAP (100)
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

/** Searchable kinds. `task` results carry `type: "entity"`. */
export const SearchKindSchema = z.enum(["task", "record", "artifact"]);
export type SearchKind = z.infer<typeof SearchKindSchema>;

export const SearchScopeSchema = z.object({
  /** Namespace restrictions on the credential narrowed the results. */
  restricted: z.boolean(),
  /** Kinds actually searched. */
  kinds: z.array(SearchKindSchema),
  /** Kinds left out, and why. */
  excluded_kinds: z
    .array(
      z.object({
        kind: SearchKindSchema,
        reason: z.enum(["restricted", "capability"]),
      }),
    )
    .optional(),
  /** Search never matches archived tasks or records. */
  archived: z.literal("excluded"),
});
export type SearchScope = z.infer<typeof SearchScopeSchema>;

export const UnifiedSearchResponseSchema = z.object({
  ok: z.literal(true),
  results: z.array(UnifiedSearchResultSchema),
  /** Number of results in this page (not a total match count). */
  total: z.number().int(),
  /** Opaque cursor for the next page, or null when there are no more results. */
  next_cursor: z.string().nullable().optional(),
  scope: SearchScopeSchema.optional(),
});

export type UnifiedSearchResponse = z.infer<typeof UnifiedSearchResponseSchema>;

const commaList = (max: number) =>
  z
    .string()
    .optional()
    .transform((v) =>
      v === undefined
        ? undefined
        : [
            ...new Set(
              v
                .split(",")
                .map((part) => part.trim())
                .filter(Boolean),
            ),
          ],
    )
    .pipe(z.array(z.string().min(1).max(200)).max(max).optional());

export const UnifiedSearchQuerySchema = z
  .object({
    q: z.string().min(1).max(200),
    limit: z
      .string()
      .optional()
      .default("20")
      .transform((v) => Number.parseInt(v, 10))
      .pipe(z.number().int().min(1).max(100)),
    tag_filter: tagFilterQueryParam,
    /** Comma list of kinds to search. Defaults to every kind the caller may read. */
    kind: commaList(3).pipe(z.array(SearchKindSchema).optional()),
    /** Comma list of task or record types. Requires exactly one of those kinds. */
    type: commaList(20),
    cursor: ListCursorSchema.optional(),
    /** `fts`: FTS5 query syntax. `literal`: plain words, prefix-matched as typed. */
    syntax: z.enum(["fts", "literal"]).default("fts"),
  })
  .superRefine((q, ctx) => {
    if (
      q.type?.length &&
      !(
        q.kind?.length === 1 &&
        (q.kind[0] === "task" || q.kind[0] === "record")
      )
    )
      ctx.addIssue({
        code: "custom",
        path: ["type"],
        message: "type requires kind=task or kind=record",
      });
  });

export type UnifiedSearchQuery = z.infer<typeof UnifiedSearchQuerySchema>;

// --- Artifact response schemas (promoted from CLI) ---

export const ArtifactTextWriteRequestSchema = z.object({
  ...ArtifactVersionFieldsSchema.shape,
  content: z.string().min(1).max(1_000_000),
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
  pointer: ArtifactRevisionSchema.optional(),
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
      metadata: z.record(z.string(), z.unknown()),
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
  vars: z.record(z.string(), z.string()).default({}),
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

export const TemplateSummarySchema = z.object({
  name: z.string(),
  /** Type of the first declared entity (the root), or "" for none. Kept for MCP/SDK callers. */
  type: z.string().default(""),
  description: z.string().nullable(),
  entity_count: z.number().int(),
  entity_types: z.array(z.string()),
  // Defaults keep a list from a server that predates these fields readable.
  /** `{{name}}` placeholders in top-level string data values, sorted. */
  variables: z.array(z.string()).default([]),
  /** Declaration order; each created ID is `root_id + id_suffix`. */
  entities: z
    .array(
      z.object({ key: z.string(), type: z.string(), id_suffix: z.string() }),
    )
    .default([]),
});
export type TemplateSummary = z.infer<typeof TemplateSummarySchema>;
export const TemplateListResponseSchema = z.object({
  ok: z.literal(true),
  templates: z.array(TemplateSummarySchema),
});
export type TemplateListResponse = z.infer<typeof TemplateListResponseSchema>;

// --- Repo Allowlist API ---

export const GitHubRepositoryPermissionSchema = z.enum([
  "read",
  "triage",
  "write",
  "maintain",
  "admin",
]);
export type GitHubRepositoryPermission = z.infer<
  typeof GitHubRepositoryPermissionSchema
>;

const GITHUB_REPOSITORY_PERMISSION_RANK: Record<
  GitHubRepositoryPermission,
  number
> = {
  read: 1,
  triage: 2,
  write: 3,
  maintain: 4,
  admin: 5,
};

function validateRepoAccessThresholds(
  policy: {
    min_read_permission: GitHubRepositoryPermission;
    min_write_permission: GitHubRepositoryPermission;
  },
  ctx: z.RefinementCtx,
): void {
  if (
    GITHUB_REPOSITORY_PERMISSION_RANK[policy.min_read_permission] >
    GITHUB_REPOSITORY_PERMISSION_RANK[policy.min_write_permission]
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "min_read_permission must not exceed min_write_permission",
      path: ["min_write_permission"],
    });
  }
}

export const RepoAccessPolicySchema = z
  .object({
    min_read_permission: GitHubRepositoryPermissionSchema,
    min_write_permission: GitHubRepositoryPermissionSchema,
    max_permission: SessionPermissionSchema,
    membership_enabled: z.boolean().default(true),
    membership_role_cap: ProjectRoleSchema.exclude(["owner"]).default(
      "participant",
    ),
  })
  .superRefine(validateRepoAccessThresholds);
export type RepoAccessPolicy = z.infer<typeof RepoAccessPolicySchema>;

export const RepoAccessPolicyRequestSchema = z
  .object({
    min_read_permission: GitHubRepositoryPermissionSchema,
    min_write_permission: GitHubRepositoryPermissionSchema,
    max_permission: SessionPermissionSchema,
    membership_enabled: z.boolean().optional(),
    membership_role_cap: ProjectRoleSchema.exclude(["owner"]).optional(),
  })
  .superRefine(validateRepoAccessThresholds);
export type RepoAccessPolicyRequest = z.infer<
  typeof RepoAccessPolicyRequestSchema
>;

export const RepoAccessPolicyResponseSchema = z.object({
  ok: z.literal(true),
  github_repo_id: z.number().int().positive(),
  policy: RepoAccessPolicySchema,
  /** Present since #298; send it back as `expected_revision`. */
  revision: z.number().int().positive().optional(),
});
export type RepoAccessPolicyResponse = z.infer<
  typeof RepoAccessPolicyResponseSchema
>;

const RepoOidcPolicyConditionSchema = z
  .array(z.string().min(1).max(512))
  .max(50)
  .refine((values) => new Set(values).size === values.length, {
    message: "Policy condition values must be unique",
  });

export const RepoOidcPolicySchema = z
  .object({
    enabled: z.boolean(),
    max_permission: SessionPermissionSchema,
    subject_pattern: z.string().min(1).max(512).nullable(),
    allowed_events: RepoOidcPolicyConditionSchema,
    allowed_refs: RepoOidcPolicyConditionSchema,
    allowed_environments: RepoOidcPolicyConditionSchema,
    allowed_workflows: RepoOidcPolicyConditionSchema,
  })
  .superRefine((policy, ctx) => {
    if (policy.enabled && policy.allowed_events.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "An enabled OIDC policy must allow at least one event",
        path: ["allowed_events"],
      });
    }
  });
export type RepoOidcPolicy = z.infer<typeof RepoOidcPolicySchema>;
export const RepoOidcPolicyRequestSchema = RepoOidcPolicySchema;
export type RepoOidcPolicyRequest = z.infer<typeof RepoOidcPolicyRequestSchema>;

export const RepoOidcPolicyResponseSchema = z.object({
  ok: z.literal(true),
  github_repo_id: z.number().int().positive(),
  policy: RepoOidcPolicySchema,
  /** Present since #298; send it back as `expected_revision`. */
  revision: z.number().int().positive().optional(),
});

/**
 * Optional precondition accepted alongside repository policy writes and link
 * removal (#298). Omitted keeps the legacy unconditional write.
 */
export const RepoPolicyPreconditionSchema = z.object({
  expected_revision: z.number().int().positive().optional(),
});

/** One linked repository with both policies and their revisions (owner view). */
export const RepoLinkSchema = z.object({
  github_host: z.string(),
  github_owner: z.string(),
  github_repo: z.string(),
  github_repo_id: z.number().int().positive(),
  created_at: z.number().int(),
  created_by: z.string(),
  /** Null when the stored policy fails validation; fix it with a full write. */
  access_policy: RepoAccessPolicySchema.nullable(),
  access_policy_revision: z.number().int().positive(),
  oidc_policy: RepoOidcPolicySchema.nullable(),
  oidc_policy_revision: z.number().int().positive(),
});
export type RepoLink = z.infer<typeof RepoLinkSchema>;
export const RepoListResponseSchema = z.object({
  ok: z.literal(true),
  repos: z.array(RepoLinkSchema),
});
export type RepoListResponse = z.infer<typeof RepoListResponseSchema>;

/** Browser-editable project metadata (#298). IDs and provenance are read-only. */
export const ProjectSettingsSchema = z.object({
  project_id: z.string(),
  display_name: z.string().nullable(),
  created_at: z.number(),
  created_by: z.string(),
  revision: z.number().int().positive(),
});
export type ProjectSettings = z.infer<typeof ProjectSettingsSchema>;
export const ProjectSettingsResponseSchema = z.object({
  ok: z.literal(true),
  settings: ProjectSettingsSchema,
});
export const UpdateProjectSettingsSchema = z
  .object({
    expected_revision: z.number().int().positive(),
    display_name: z.string().trim().min(1).max(100).nullable(),
  })
  .strict();
export type UpdateProjectSettings = z.infer<typeof UpdateProjectSettingsSchema>;
export type RepoOidcPolicyResponse = z.infer<
  typeof RepoOidcPolicyResponseSchema
>;

export const RepoRegisterRequestSchema = z
  .object({
    owner: z.string().min(1).max(100),
    repo: z.string().min(1).max(100),
    github_host: z.string().optional().default("github.com"),
    github_token: z.string().optional(),
    min_read_permission:
      GitHubRepositoryPermissionSchema.optional().default("write"),
    min_write_permission:
      GitHubRepositoryPermissionSchema.optional().default("write"),
    max_permission: SessionPermissionSchema.optional().default("write"),
    membership_enabled: z.boolean().optional().default(false),
    membership_role_cap: ProjectRoleSchema.exclude(["owner"])
      .optional()
      .default("participant"),
  })
  .superRefine(validateRepoAccessThresholds);
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

// --- Schema-method response types (C3: named wrappers, inner content stays unknown) ---

export const SchemaApplyRequestSchema = z
  .object({
    definition: z.string().min(1),
    strategy: z.enum(["relax", "force"]).optional(),
    expected_revision: z.number().int().nonnegative().optional(),
    reviewed_definition: z.string().min(1).optional(),
    idempotency_key: z.string().min(1).max(256).optional(),
  })
  .refine(
    (value) =>
      value.reviewed_definition === undefined ||
      value.expected_revision !== undefined,
    {
      message: "reviewed_definition requires expected_revision",
    },
  );
export type SchemaApplyRequest = z.infer<typeof SchemaApplyRequestSchema>;

/** A definition problem with the dotted path or TOML position it concerns. */
export const SchemaParseErrorSchema = z.object({
  message: z.string(),
  path: z.string().optional(),
  line: z.number().int().optional(),
  column: z.number().int().optional(),
});
export type SchemaParseErrorItem = z.infer<typeof SchemaParseErrorSchema>;

const PreviewFieldDeclarationSchema = z.object({
  type: z.string(),
  required: z.boolean().optional(),
  default: z.unknown().optional(),
  default_for_legacy: z.unknown().optional(),
  values: z.array(z.string()).optional(),
});

/**
 * What changing an artifact kind's policy does to stored artifacts. Expiry
 * already assigned to existing artifacts is never rewritten; only new writes,
 * and legacy revisions still waiting for a retention snapshot, can pick up a
 * new `retention_days`.
 */
export const ArtifactPolicyImpactSchema = z.object({
  /** Live (not tombstoned) artifacts of this kind. Their expiry is unchanged. */
  liveArtifacts: z.number().int().nonnegative(),
  retention: z
    .object({
      from: z.number().int(),
      to: z.number().int(),
      /** Legacy revisions not yet given an expiry by the retention backfill. */
      pendingBackfill: z.number().int().nonnegative(),
      /**
       * False once the backfill has snapshotted the policy: pending revisions
       * then keep the snapshot, not this new value.
       */
      pendingBackfillUsesNewPolicy: z.boolean(),
    })
    .optional(),
  /** Search settings changed; already indexed content is not reindexed. */
  searchChanged: z.boolean(),
});
export type ArtifactPolicyImpact = z.infer<typeof ArtifactPolicyImpactSchema>;

/** One semantic change in a definition preview, with database impact counts. */
export const SchemaPreviewChangeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("work-unit-added"), unitType: z.string() }),
  z.object({
    kind: z.literal("work-unit-removed"),
    unitType: z.string(),
    /** Unarchived tasks of this type; they stay readable as legacy rows. */
    entityCount: z.number().int(),
    archivedCount: z.number().int().optional(),
  }),
  z.object({
    kind: z.literal("field-added"),
    unitType: z.string(),
    fieldName: z.string(),
    declaration: PreviewFieldDeclarationSchema,
    /** Existing tasks without the field that will read `default_for_legacy`. */
    legacyDefaultCount: z.number().int().optional(),
  }),
  z.object({
    kind: z.literal("field-removed"),
    unitType: z.string(),
    fieldName: z.string(),
    entityCount: z.number().int(),
  }),
  z.object({
    kind: z.literal("field-required-added"),
    unitType: z.string(),
    fieldName: z.string(),
    declaration: PreviewFieldDeclarationSchema,
  }),
  z.object({
    kind: z.literal("artifact-kind-added"),
    artifactKind: z.string(),
  }),
  z.object({
    kind: z.literal("artifact-kind-removed"),
    artifactKind: z.string(),
    /** Live artifacts of this kind. Removing the kind deletes no blobs. */
    artifactCount: z.number().int(),
    lineageCount: z.number().int().optional(),
  }),
  z.object({ kind: z.literal("record-type-added"), typeName: z.string() }),
  z.object({
    kind: z.literal("record-type-removed"),
    typeName: z.string(),
    recordCount: z.number().int(),
    archivedCount: z.number().int().optional(),
  }),
  z.object({
    kind: z.literal("record-field-added"),
    typeName: z.string(),
    fieldName: z.string(),
    declaration: PreviewFieldDeclarationSchema,
    legacyDefaultCount: z.number().int().optional(),
  }),
  z.object({
    kind: z.literal("record-field-removed"),
    typeName: z.string(),
    fieldName: z.string(),
    recordCount: z.number().int().optional(),
  }),
  z.object({
    kind: z.literal("record-field-required-added"),
    typeName: z.string(),
    fieldName: z.string(),
    declaration: PreviewFieldDeclarationSchema,
  }),
  z.object({
    kind: z.literal("definition-changed"),
    path: z.string(),
    destructive: z.boolean(),
    impact: ArtifactPolicyImpactSchema.optional(),
  }),
]);
export type SchemaPreviewChange = z.infer<typeof SchemaPreviewChangeSchema>;

export const SchemaPreviewResponseSchema = z.object({
  ok: z.literal(true),
  revision: z.number().int().nonnegative(),
  reviewed_definition: z.string(),
  changes: z.array(SchemaPreviewChangeSchema),
  autoApplicable: z.boolean(),
});
export type SchemaPreviewResponse = z.infer<typeof SchemaPreviewResponseSchema>;

export const SchemaGetResponseSchema = z.object({
  ok: z.literal(true),
  schema: z.unknown().optional(),
  version: z.number().int().nullable(),
  revision: z.number().int().nonnegative().optional(),
});

export type SchemaGetResponse = z.infer<typeof SchemaGetResponseSchema>;

/** Accepted legacy writes remain compatible, but must be visible to callers. */
export const SchemaApplyWarningSchema = z.object({
  code: z.literal("schema-revision-deprecated"),
  message: z.string(),
  /** Absent on receipts created before warnings were recorded. */
  observed_revision: z.number().int().nonnegative().optional(),
  result_revision: z.number().int().nonnegative(),
});

export type SchemaApplyWarning = z.infer<typeof SchemaApplyWarningSchema>;

export const SchemaApplyResponseSchema = z.object({
  ok: z.literal(true),
  version: z.number().int().nullable(),
  revision: z.number().int().nonnegative().optional(),
  changes: z.array(z.string()).optional(),
  noChange: z.boolean().optional(),
  diff: z.unknown().optional(),
  // Optional for compatibility with servers predating revision warnings.
  warnings: z.array(SchemaApplyWarningSchema).optional(),
});

export type SchemaApplyResponse = z.infer<typeof SchemaApplyResponseSchema>;

export const SchemaHistoryResponseSchema = z.object({
  ok: z.literal(true),
  entries: z.array(z.unknown()),
});

export type SchemaHistoryResponse = z.infer<typeof SchemaHistoryResponseSchema>;

// --- Record API ---

export const RecordCreateRequestSchema = z.object({
  key: RecordKeySchema,
  value: z.record(z.string(), z.unknown()),
  tags: RecordTagSchema.optional(),
  message: z.string().optional(),
  source_artifact_key: z.string().nullable().optional(),
});

export type RecordCreateRequest = z.infer<typeof RecordCreateRequestSchema>;

export const RecordSetRequestSchema = z.object({
  value: z.record(z.string(), z.unknown()),
  fence: z.number().int(),
  tags: RecordTagSchema.optional(),
  message: z.string().optional(),
  source_artifact_key: z.string().nullable().optional(),
});

export type RecordSetRequest = z.infer<typeof RecordSetRequestSchema>;

export const RecordPutRequestSchema = z.object({
  value: z.record(z.string(), z.unknown()),
  tags: RecordTagSchema.optional(),
  message: z.string().optional(),
  source_artifact_key: z.string().nullable().optional(),
});

export type RecordPutRequest = z.infer<typeof RecordPutRequestSchema>;

export const RecordPatchRequestSchema = z.object({
  patch: z.record(z.string(), z.unknown()),
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
  value: z.record(z.string(), z.unknown()),
  value_sha256: z.string(),
  revision: z.number().int(),
  archived: z.number().int(),
  created_at: z.number().int(),
  updated_at: z.number().int(),
  updated_by: z.string(),
  tags: z.array(z.string()),
});

export type RecordItem = z.infer<typeof RecordItemSchema>;

/**
 * Internal record row as produced by backend ops modules (`@tila/ops-sqlite`,
 * `cli/src/local`). Unlike `RecordItemSchema` (the HTTP wire shape), this
 * adds the `fence` token, which destructive record mutations require.
 *
 * Defined as `RecordItemSchema.extend(...)` so the wire shape and the internal
 * row stay structurally coupled by construction — any field added to the wire
 * type flows into `RecordRow` automatically, preventing drift.
 *
 * Canonical home for the `RecordRow` type consumed by `RecordBackend`
 * (`@tila/core`) and the ops modules — do not redefine it elsewhere.
 */
export const RecordRowSchema = RecordItemSchema.extend({
  fence: z.number().int(),
});

export type RecordRow = z.infer<typeof RecordRowSchema>;

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
  /** Value of the type's declared `presentation.title` field; absent when none is declared. */
  title: z.string().nullable().optional(),
});

export type RecordListItem = z.infer<typeof RecordListItemSchema>;

export const RECORD_LIST_SORTS = ["key", "updated_at", "revision"] as const;

/** Paging and search parameters for `GET /records/:type`. */
export const RecordListQuerySchema = z.object({
  cursor: ListCursorSchema.optional(),
  sort: z.enum(RECORD_LIST_SORTS).optional(),
  order: z.enum(["asc", "desc"]).optional(),
  key_contains: z.string().min(1).max(200).optional(),
});
export type RecordListQuery = z.infer<typeof RecordListQuerySchema>;

export const RecordListResponseSchema = z.object({
  ok: z.literal(true),
  items: z.array(RecordListItemSchema),
  meta: z.object({
    total: z.number().int(),
    limit: z.number().int(),
    /** Opaque keyset cursor for the next page, or null on the last page. */
    next_cursor: z.string().nullable(),
    scope: ResultScopeSchema.optional(),
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
  /**
   * Authenticated author of the revision. `null` for revisions written before
   * project migration 43, which are never backfilled. Absent only from
   * responses produced by an older Worker.
   */
  principal_id: z.string().nullable().optional(),
  /**
   * Credential that signed the write. `null` for browser/OIDC/workspace
   * sessions and for revisions that stored none. Absent only from responses
   * produced by an older Worker.
   */
  token_id: z.string().nullable().optional(),
  created_at: z.number().int(),
  message: z.string().nullable(),
  // Populated only when the history is requested with `includeValues=true`
  // (wire: `?values=true`). Optional so existing parsers stay compatible.
  value: z.record(z.string(), z.unknown()).optional(),
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

/**
 * Present on a types listing only when part of it could not be produced, so a
 * short list is not mistaken for a complete one. Keys mirror the arrays they
 * qualify. Absent means complete; "no schema configured" is complete, with an
 * empty `declared_types`, and is not reported here.
 *
 * Never sent to credentials with namespace restrictions.
 */
export const RecordTypesIncompleteSchema = CatalogIncompleteSchema;

export type RecordTypesIncomplete = z.infer<typeof RecordTypesIncompleteSchema>;

export const RecordTypesResponseSchema = z.object({
  ok: z.literal(true),
  types: z.array(z.string()),
  declared_types: z.array(z.string()).optional(),
  in_use_types: z.array(z.string()).optional(),
  incomplete: RecordTypesIncompleteSchema.optional(),
  /** Per-type catalog entries with declaration status and visible counts. */
  entries: z.array(RecordCatalogEntrySchema).optional(),
  scope: ResultScopeSchema.optional(),
});

export type RecordTypesResponse = z.infer<typeof RecordTypesResponseSchema>;
import { ArtifactVersionFieldsSchema } from "./artifact-version";
