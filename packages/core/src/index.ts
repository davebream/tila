// Backend interfaces
export type {
  EntityBackend,
  CreateEntityInput,
  EntityListFilter,
  RelationshipInput,
  RelationshipFilter,
  ReadyFilter,
  AddArtifactRefInput,
  EntityTree,
} from "./interfaces/entity-backend";
export type {
  CoordinationBackend,
  AcquireResult,
  RenewResult,
} from "./interfaces/coordination-backend";
export type {
  ArtifactBackend,
  ArtifactPutOptions,
  ArtifactPointerRecord,
  ArtifactRelationship,
  ArtifactSearchResultRecord,
  ArtifactIndexEntry,
} from "./interfaces/artifact-backend";
export type {
  JournalBackend,
  JournalQuery,
  JournalEvent,
} from "./interfaces/journal-backend";
export type {
  GateBackend,
  GateFilter,
  GateRecord,
} from "./interfaces/gate-backend";
export type {
  SignalBackend,
  SendSignalInput,
  SignalRecord,
} from "./interfaces/signal-backend";
export type {
  SchemaBackend,
  SchemaRecord,
  ApplySchemaInput,
  ApplySchemaOutput,
} from "./interfaces/schema-backend";
export type {
  SummaryBackend,
  ProjectSummary,
} from "./interfaces/summary-backend";
export type {
  RecordBackend,
  CreateRecordInput,
  SetRecordInput,
  PatchRecordInput,
  ArchiveRecordInput,
  RecordListFilter,
  RecordHistoryOptions,
  RecordPage,
} from "./interfaces/record-backend";

// Fence validation utilities
export { validateFence, assertFence, FenceError } from "./fence";

// Schema evolution helpers
export {
  tolerantRead,
  validatedWrite,
  applyLegacyDefaults,
  diffSchemas,
  type ValidationResult,
  type SchemaChange,
  type SchemaFieldChange,
  type SchemaUnitChange,
  type SchemaArtifactChange,
  type SchemaRecordChange,
  type SchemaDiffResult,
} from "./schema-evolution";

// Record evolution helpers
export { applyRecordLegacyDefaults } from "./record-evolution";

// Schema parser
export {
  parseSchemaToml,
  parseTilaSchemaToml,
  SchemaParseException,
  type ParseSchemaResult,
  type SchemaParseError,
} from "./schema-parser";

// Semver utilities
export { compareSemver } from "./semver";

// Schema fragment composition engine
export {
  composeSchemaFragments,
  type SchemaFragment,
  type ComposeWarning,
  type ComposeSchemaResult,
} from "./schema-compose";

// Grep matcher, validator, line-splitter, and cap constants
export {
  GrepQueryError,
  GREP_CANDIDATE_CAP,
  GREP_PER_BLOB_BYTE_CAP,
  GREP_TOTAL_BYTE_CAP,
  GREP_INLINE_RESPONSE_BUDGET,
  GREP_MAX_MATCHES,
  GREP_MAX_MATCHES_PER_BLOB,
  GREP_MAX_LINE_TEXT,
  GREP_REGEX_LINE_INPUT_CAP,
  GREP_DEADLINE_MS,
  validateGrepPattern,
  compileGrepMatcher,
  matchLine,
  splitChunkIntoLines,
  type GrepMatcher,
} from "./grep";
