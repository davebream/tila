// tila-sdk -- TypeScript SDK for tila consumers

// Core client
export {
  TilaClient,
  TilaApiError,
  isTilaApiError,
  exchangeGitHubToken,
} from "./client";
export type { ClientOptions } from "./client";

// Retry helper
export { withRetry } from "./retry";
export type { RetryOptions } from "./retry";

// Error code constants
export { TILA_ERRORS } from "./error-codes";
export type { TilaErrorCode } from "./error-codes";

// Method factories
export {
  createTaskMethods,
  createEntityMethods,
  createWorkUnitMethods,
} from "./entities";
export { createClaimMethods } from "./claims";
export { createArtifactMethods } from "./artifacts";
export type { ArtifactUploadOpts } from "./artifacts";
export { createTokenMethods } from "./tokens";
export { createJournalMethods } from "./journal";
export { createPresenceMethods } from "./presence";
export { createRecordMethods } from "./records";
export { createSchemaMethods } from "./schema";
export { createSignalMethods } from "./signals";
export { createGateMethods } from "./gates";
export { createTemplateMethods } from "./templates";
export { createIndexMethods } from "./indexes";
export type { IndexCreateOpts } from "./indexes";
export { createSummaryMethods } from "./summary";
export { createSearchMethods } from "./search";

// Coordination primitives
export { ClaimHandle, withClaim } from "./claim-handle";
export type { ClaimHandleOptions } from "./claim-handle";

// Re-export key types consumers need
export type {
  // Entity types
  EntityResponse,
  EntityDetailResponse,
  EntityListResponse,
  // Claim types
  AcquireSuccessResponse,
  RenewSuccessResponse,
  ReleaseSuccessResponse,
  // Artifact types
  ArtifactPutResponse,
  ArtifactListResponse,
  ArtifactSearchResponse,
  ArtifactGrepResponse,
  // Token types
  TokenIssueResponse,
  TokenListResponse,
  TokenRevokeResponse,
  // Journal types
  JournalResponse,
  // Presence types
  PresenceListResponse,
  PresenceAllListResponse,
  // Signal types
  InboxResponse,
  SendSignalRequest,
  SendSignalResponse,
  AckSignalResponse,
  // Gate types
  GateListResponse,
  GateResponse,
  CreateGateRequest,
  ResolveGateRequest,
  // Template types
  InstantiateTemplateRequest,
  InstantiateTemplateResponse,
  // Summary types
  SummaryResponse,
  // Record types
  RecordGetResponse,
  RecordMutateResponse,
  RecordListResponse,
  RecordListItem,
  RecordHistoryResponse,
  RecordHistoryItem,
  RecordItem,
  RecordTypesResponse,
  RecordCreateRequest,
  RecordSetRequest,
  RecordPatchRequest,
  RecordArchiveRequest,
  RecordUnarchiveRequest,
  // Search types
  UnifiedSearchResponse,
  UnifiedSearchResult,
  UnifiedSearchQuery,
} from "@tila/schemas";
