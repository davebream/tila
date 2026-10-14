// --- DO SQLite row schemas ---
export { EntitySchema, type Entity } from "./entity";
export * from "./agent";
export * from "./agent-binding";
export * from "./profile";
export {
  ClaimModeSchema,
  type ClaimMode,
  ClaimSchema,
  type Claim,
} from "./claim";
export {
  ParticipantIdSchema,
  type ParticipantId,
  EnvironmentMetadataSchema,
  type EnvironmentMetadata,
  IdentityContextSchema,
  type IdentityContext,
} from "./identity";
export {
  JournalEventKindSchema,
  type JournalEventKind,
  JournalEventSchema,
  type JournalEvent,
} from "./journal";
export {
  ArtifactPointerSchema,
  type ArtifactPointer,
  EntityArtifactReferenceSchema,
  type EntityArtifactReference,
  ArtifactRelationshipTypeSchema,
  type ArtifactRelationshipType,
  ArtifactRelationshipSchema,
  type ArtifactRelationship,
  ArtifactSearchResultSchema,
  type ArtifactSearchResult,
  EntitySearchResultSchema,
  type EntitySearchResult,
} from "./artifact";
export { FenceSchema, type Fence } from "./fence";
export {
  PROJECT_BACKUP_FORMAT,
  PROJECT_BACKUP_FORMAT_VERSION,
  ProjectBackupHeaderSchema,
  type ProjectBackupHeader,
  ProjectBackupEntrySchema,
  type ProjectBackupEntry,
  ProjectBackupObjectSchema,
  type ProjectBackupObject,
  ProjectBackupManifestSchema,
  type ProjectBackupManifest,
  ProjectTransferModeSchema,
  type ProjectTransferMode,
  ProjectTransferStateSchema,
  type ProjectTransferState,
} from "./backup";
export { PresenceSchema, type Presence } from "./presence";
export {
  EntityRelationshipTypeSchema,
  type EntityRelationshipType,
  EntityRelationshipSchema,
  type EntityRelationship,
} from "./relationship";

// --- Signal schemas ---
export {
  SignalKindSchema,
  type SignalKind,
  SignalTargetSchema,
  type SignalTarget,
  SignalIdentitySchema,
  type SignalIdentity,
  SignalDeliverySchema,
  type SignalDelivery,
  SignalSchema,
  type Signal,
  SignalGroupIdSchema,
  SignalGroupSchema,
  type SignalGroup,
} from "./signal";

// --- DO SQLite: schema history ---
export {
  SchemaHistorySchema,
  type SchemaHistory,
  SchemaHistoryEntrySchema,
  type SchemaHistoryEntry,
  ApplyStrategySchema,
  type ApplyStrategy,
} from "./schema-history";

// --- D1 global table schemas ---
export {
  D1ProjectSchema,
  type D1Project,
  D1TokenSchema,
  type D1Token,
  D1IdempotencySchema,
  type D1Idempotency,
} from "./d1";

// --- Config schemas ---
export { DeployTargetSchema, type DeployTarget } from "./deploy-target";
export {
  TilaProjectConfigSchema,
  type TilaProjectConfig,
  TilaSchemaTomlSchema,
  type TilaSchemaToml,
  FieldDeclarationSchema,
  type FieldDeclaration,
  WorkPresentationSchema,
  type WorkPresentation,
  RecordPresentationSchema,
  type RecordPresentation,
  type WorkUnit,
  type ReferenceSlot,
  type ArtifactKind,
  type TemplateDefinition,
  type TemplateEntity,
  type TemplateRelationship,
  RecordDefinitionSchema,
  type RecordDefinition,
  SCHEMA_SECTION_MERGE_POLICY,
  type SchemaSectionMergePolicy,
  DEFINITION_MAX_BYTES,
  DEFINITION_REQUEST_MAX_BYTES,
  DEFINITION_EXPORT_KEY,
  DEFINITION_EXPORT_FORMAT,
  DEFINITION_EXPORT_FORMAT_VERSION,
  DefinitionExportMetadataSchema,
  type DefinitionExportMetadata,
  definitionByteLength,
} from "./config";
export {
  TilaInfraConfigSchema,
  type TilaInfraConfig,
  PerSlugInfraMetaSchema,
  type PerSlugInfraMeta,
  InfraSecretsSchema,
  type InfraSecrets,
} from "./infra-config";

// --- Multi-instance auth registry schemas ---
export {
  InstanceKey,
  CredentialProviderConfigSchema,
  type CredentialProviderConfig,
  InstanceRecordSchema,
  type InstanceRecord,
  InstanceRegistrySchema,
  type InstanceRegistry,
} from "./instance-registry";
export { CredentialRecordSchema, type CredentialRecord } from "./credential";
export { RefreshRecordSchema, type RefreshRecord } from "./refresh";

// --- API request/response contracts ---
export {
  ErrorEnvelopeSchema,
  type ErrorEnvelope,
  AcquireRequestSchema,
  type AcquireRequest,
  AcquireSuccessResponseSchema,
  type AcquireSuccessResponse,
  RenewRequestSchema,
  type RenewRequest,
  RenewSuccessResponseSchema,
  type RenewSuccessResponse,
  ReleaseRequestSchema,
  type ReleaseRequest,
  ReleaseSuccessResponseSchema,
  type ReleaseSuccessResponse,
  StateResponseSchema,
  type StateResponse,
  CreateEntityRequestSchema,
  type CreateEntityRequest,
  UpdateEntityRequestSchema,
  type UpdateEntityRequest,
  ArchiveRequestSchema,
  type ArchiveRequest,
  EntityResponseSchema,
  type EntityResponse,
  EntityListResponseSchema,
  type EntityListResponse,
  ListReadyEntitiesResponseSchema,
  type ListReadyEntitiesResponse,
  CompactEntitySchema,
  type CompactEntity,
  CompactEntityListResponseSchema,
  type CompactEntityListResponse,
  CompactEntityResponseSchema,
  type CompactEntityResponse,
  PaginatedEntityListResponseSchema,
  type PaginatedEntityListResponse,
  PaginatedCompactEntityListResponseSchema,
  type PaginatedCompactEntityListResponse,
  SummaryResponseSchema,
  type SummaryResponse,
  EntityDetailResponseSchema,
  type EntityDetailResponse,
  ArchiveSuccessResponseSchema,
  type ArchiveSuccessResponse,
  CreateEntityRelationshipRequestSchema,
  type CreateEntityRelationshipRequest,
  CreateEntityRelationshipResponseSchema,
  type CreateEntityRelationshipResponse,
  ListEntityRelationshipsRequestSchema,
  type ListEntityRelationshipsRequest,
  ListEntityRelationshipsResponseSchema,
  type ListEntityRelationshipsResponse,
  DeleteEntityRelationshipRequestSchema,
  type DeleteEntityRelationshipRequest,
  DeleteEntityRelationshipResponseSchema,
  type DeleteEntityRelationshipResponse,
  JournalQuerySchema,
  type JournalQuery,
  JournalResponseSchema,
  type JournalResponse,
  PresenceHeartbeatRequestSchema,
  type PresenceHeartbeatRequest,
  PresenceListResponseSchema,
  type PresenceListResponse,
  PresenceAllListResponseSchema,
  type PresenceAllListResponse,
  PresenceHeartbeatSuccessResponseSchema,
  type PresenceHeartbeatSuccessResponse,
  StateListResponseSchema,
  type StateListResponse,
  HealthResponseSchema,
  type HealthResponse,
  WhoamiResponseSchema,
  type WhoamiResponse,
  DOHealthResponseSchema,
  type DOHealthResponse,
  StoreCountsResponseSchema,
  type StoreCountsResponse,
  DoctorProbeResponseSchema,
  type DoctorProbeResponse,
  SqliteColumnInfoSchema,
  type SqliteColumnInfo,
  SchemaMigrationRecordSchema,
  type SchemaMigrationRecord,
  DoctorSchemaSuccessResponseSchema,
  type DoctorSchemaSuccessResponse,
  DoctorSchemaStaleResponseSchema,
  type DoctorSchemaStaleResponse,
  DoctorSchemaResponseSchema,
  type DoctorSchemaResponse,
  TokenIssueRequestSchema,
  type TokenIssueRequest,
  TokenIssueResponseSchema,
  type TokenIssueResponse,
  TokenRevokeResponseSchema,
  type TokenRevokeResponse,
  TokenListItemSchema,
  MembershipGrantResponseSchema,
  type MembershipGrantResponse,
  type TokenListItem,
  TokenListResponseSchema,
  type TokenListResponse,
  AddEntityArtifactReferenceRequestSchema,
  type AddEntityArtifactReferenceRequest,
  EntityArtifactReferenceListResponseSchema,
  type EntityArtifactReferenceListResponse,
  ReconcileDetailSchema,
  type ReconcileDetail,
  ReconcileReportSchema,
  type ReconcileReport,
  SearchRebuildDetailSchema,
  type SearchRebuildDetail,
  SearchRebuildReportSchema,
  type SearchRebuildReport,
  SearchDriftCheckNameSchema,
  type SearchDriftCheckName,
  SearchDriftFindingSchema,
  type SearchDriftFinding,
  SearchDriftReportSchema,
  type SearchDriftReport,
  ArtifactSearchResponseSchema,
  type ArtifactSearchResponse,
  ArtifactSearchQuerySchema,
  type ArtifactSearchQuery,
  ArtifactTextWriteRequestSchema,
  type ArtifactTextWriteRequest,
  ArtifactPutResponseSchema,
  type ArtifactPutResponse,
  ArtifactListResponseSchema,
  type ArtifactListResponse,
  ArtifactRelationshipOkResponseSchema,
  type ArtifactRelationshipOkResponse,
  ArtifactRelationshipListResponseSchema,
  type ArtifactRelationshipListResponse,
  InstantiateTemplateRequestSchema,
  type InstantiateTemplateRequest,
  InstantiateTemplateResponseSchema,
  type InstantiateTemplateResponse,
  TemplateSummarySchema,
  type TemplateSummary,
  TemplateListResponseSchema,
  type TemplateListResponse,
  GitHubRepositoryPermissionSchema,
  type GitHubRepositoryPermission,
  RepoAccessPolicySchema,
  type RepoAccessPolicy,
  RepoAccessPolicyRequestSchema,
  type RepoAccessPolicyRequest,
  RepoAccessPolicyResponseSchema,
  type RepoAccessPolicyResponse,
  RepoOidcPolicySchema,
  type RepoOidcPolicy,
  RepoOidcPolicyRequestSchema,
  type RepoOidcPolicyRequest,
  RepoOidcPolicyResponseSchema,
  type RepoOidcPolicyResponse,
  RepoRegisterRequestSchema,
  type RepoRegisterRequest,
  RepoRegisterResponseSchema,
  type RepoRegisterResponse,
  RepoDeleteResponseSchema,
  type RepoDeleteResponse,
  RepoPolicyPreconditionSchema,
  RepoLinkSchema,
  type RepoLink,
  RepoListResponseSchema,
  type RepoListResponse,
  ProjectSettingsSchema,
  type ProjectSettings,
  ProjectSettingsResponseSchema,
  UpdateProjectSettingsSchema,
  type UpdateProjectSettings,
  RecordCreateRequestSchema,
  type RecordCreateRequest,
  RecordSetRequestSchema,
  type RecordSetRequest,
  RecordPutRequestSchema,
  type RecordPutRequest,
  RecordPatchRequestSchema,
  type RecordPatchRequest,
  RecordArchiveRequestSchema,
  type RecordArchiveRequest,
  RecordUnarchiveRequestSchema,
  type RecordUnarchiveRequest,
  RecordItemSchema,
  type RecordItem,
  RecordRowSchema,
  type RecordRow,
  RecordGetResponseSchema,
  type RecordGetResponse,
  RecordMutateResponseSchema,
  type RecordMutateResponse,
  RecordListItemSchema,
  type RecordListItem,
  RecordListResponseSchema,
  type RecordListResponse,
  RECORD_LIST_SORTS,
  RecordListQuerySchema,
  type RecordListQuery,
  RecordHistoryItemSchema,
  type RecordHistoryItem,
  RecordHistoryResponseSchema,
  type RecordHistoryResponse,
  RecordTypesIncompleteSchema,
  type RecordTypesIncomplete,
  RecordTypesResponseSchema,
  type RecordTypesResponse,
  RecordSearchResultSchema,
  type RecordSearchResult,
  UnifiedSearchResultSchema,
  type UnifiedSearchResult,
  UnifiedSearchResponseSchema,
  type UnifiedSearchResponse,
  UnifiedSearchQuerySchema,
  type UnifiedSearchQuery,
  SearchKindSchema,
  type SearchKind,
  SearchScopeSchema,
  type SearchScope,
  ListCursorSchema,
  TASK_LIST_SORTS,
  TaskListQuerySchema,
  type TaskListQuery,
  TaskListPageOptionsSchema,
  type TaskListPageOptions,
  ArtifactGrepLineSchema,
  ArtifactGrepResultSchema,
  ArtifactGrepResponseSchema,
  type ArtifactGrepResponse,
  ArtifactGrepQuerySchema,
  type ArtifactGrepQuery,
  parseTagFilter,
  tagFilterQueryParam,
  SchemaGetResponseSchema,
  SchemaApplyRequestSchema,
  type SchemaApplyRequest,
  SchemaPreviewResponseSchema,
  type SchemaPreviewResponse,
  SchemaPreviewChangeSchema,
  type SchemaPreviewChange,
  SchemaParseErrorSchema,
  type SchemaParseErrorItem,
  ArtifactPolicyImpactSchema,
  type ArtifactPolicyImpact,
  type SchemaGetResponse,
  SchemaApplyResponseSchema,
  type SchemaApplyResponse,
  SchemaApplyWarningSchema,
  type SchemaApplyWarning,
  SchemaHistoryResponseSchema,
  type SchemaHistoryResponse,
} from "./api";

// --- Signal API request/response contracts ---
export {
  SendSignalRequestSchema,
  type SendSignalRequest,
  SendSignalResponseSchema,
  type SendSignalResponse,
  InboxResponseSchema,
  type InboxResponse,
  SignalHistoryResponseSchema,
  type SignalHistoryResponse,
  AckSignalResponseSchema,
  type AckSignalResponse,
  SetSignalGroupRequestSchema,
  type SetSignalGroupRequest,
  SignalGroupResponseSchema,
  type SignalGroupResponse,
  SignalGroupsResponseSchema,
  type SignalGroupsResponse,
} from "./signal";

// --- Search schemas ---
export {
  NormalizedArtifactTextSchema,
  type NormalizedArtifactText,
} from "./search";

// --- Session schemas ---
export {
  SessionPermissionSchema,
  type SessionPermission,
  SessionPayloadSchema,
  type SessionPayload,
  GitHubExchangeRequestSchema,
  type GitHubExchangeRequest,
  GitHubExchangeResponseSchema,
  type GitHubExchangeResponse,
  GitHubAppInstallationConfigSchema,
  type GitHubAppInstallationConfig,
  GitHubAppExchangeRequestSchema,
  type GitHubAppExchangeRequest,
  GitHubAppInfoResponseSchema,
  type GitHubAppInfoResponse,
  OidcExchangeResponseSchema,
  type OidcExchangeResponse,
  OidcExchangeRequestSchema,
  type OidcExchangeRequest,
} from "./session";

// --- Session cookie schemas (UI httpOnly cookie flow) ---
export {
  SessionExchangeRequestSchema,
  type SessionExchangeRequest,
  SessionExchangeResponseSchema,
  type SessionExchangeResponse,
  SessionCapabilitiesSchema,
  type SessionCapabilities,
  SessionStatusResponseSchema,
  type SessionStatusResponse,
} from "./session-cookie";

// --- Gate schemas ---
export {
  GateAwaitTypeSchema,
  type GateAwaitType,
  GateStatusSchema,
  type GateStatus,
  GateSchema,
  type Gate,
  CreateGateRequestSchema,
  type CreateGateRequest,
  ResolveGateRequestSchema,
  type ResolveGateRequest,
  GateResponseSchema,
  type GateResponse,
  GateListResponseSchema,
  type GateListResponse,
} from "./gate";

// --- Deploy route constants ---
export { RUN_WORKER_FIRST } from "./deploy-routes";

// --- HTTP response-envelope factories (pure, no Hono/Response) ---
export { errorEnvelope, okEnvelope } from "./envelope";

// --- Tag schemas (shared across records, entities, and artifacts) ---
export { TagSchema, type Tag, TagsSchema, type Tags } from "./tags";

// --- GitHub validation constants ---
export {
  GITHUB_LOGIN_REGEX,
  GitHubLoginConfigResponseSchema,
  type GitHubLoginConfigResponse,
} from "./github";

// --- Canonical project membership ---
export {
  MembershipGrantRequestSchema,
  type MembershipGrantRequest,
  MembershipPolicyRequestSchema,
  type MembershipPolicyRequest,
  MembershipPrincipalSchema,
  type MembershipPrincipal,
  PrincipalRevocationRequestSchema,
  type PrincipalRevocationRequest,
  MembershipRoleUpdateRequestSchema,
  type MembershipRoleUpdateRequest,
  MembershipSourceSchema,
  type MembershipSource,
  MembershipSubjectKindSchema,
  type MembershipSubjectKind,
  PROJECT_ROLE_RANK,
  ProjectMembershipModeSchema,
  type ProjectMembershipMode,
  ProjectMembershipSchema,
  type ProjectMembership,
  ProjectRoleSchema,
  type ProjectRole,
  roleToPermission,
} from "./membership";

// --- DPoP shared helpers ---
export { canonicalizeHtu, accessTokenHash, DPOP_TYP, DPOP_ALG } from "./dpop";

// --- Record schemas ---
export {
  RecordTypeSchema,
  type RecordType,
  RecordKeySchema,
  type RecordKey,
  RecordTagSchema,
  type RecordTag,
  RecordValueSchema,
  type RecordValue,
  formatRecordResource,
  parseRecordResource,
  canonicalJson,
  canonicalJsonSha256,
} from "./record";

export * from "./capability";
export * from "./continuity";
export * from "./artifact-version";
export * from "./artifact-lifecycle";
export * from "./lifecycle";
export * from "./artifact-review";

export * from "./mcp-workflow";
export * from "./mcp-results";
export * from "./cli-output";

export * from "./workload";
export * from "./runtime";
export * from "./runtime-view";

export * from "./conversation";

export * from "./connector";

export * from "./human-account";
export {
  LIFECYCLE_OUTCOMES,
  LifecycleOutcomeSchema,
  type LifecycleOutcome,
  WorkLifecycleSchema,
  type WorkLifecycle,
} from "./config";
export {
  WorkBlockReasonSchema,
  WorkReadinessSchema,
  type WorkBlockReason,
  type WorkReadiness,
} from "./readiness";

export * from "./queue";
export * from "./catalog";
export { presentedTitle, presentedText } from "./presentation";

export * from "./question";
export * from "./custom-journal";
