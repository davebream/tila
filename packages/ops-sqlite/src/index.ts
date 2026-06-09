// Schema namespace -- consumers use `import { schema } from "@tila/ops-sqlite"`
// to get only Drizzle table definitions (for drizzle() config and query building).
// IMPORTANT: Do NOT use `export * from "./schema"` at the top level because it
// would mix table definitions with ops modules in `import * as X from "@tila/ops-sqlite"`.
export * as schema from "./schema";

// Migrations
export {
  MIGRATIONS,
  MIGRATION_BOOTSTRAP,
  MIGRATION_0001,
  MIGRATION_0002,
  MIGRATION_0003,
  MIGRATION_0004,
  MIGRATION_0005,
  MIGRATION_0006,
  MIGRATION_0007,
  MIGRATION_0008,
  MIGRATION_0009,
  MIGRATION_0010,
  MIGRATION_0011,
  MIGRATION_0012,
  MIGRATION_0013,
  MIGRATION_0014,
  MIGRATION_0015,
  MIGRATION_0016,
  MIGRATION_0018,
  runMigration0002,
  runMigration0004,
  runMigration0010,
  runMigration0011,
  runMigration0013,
  runMigration0014,
  runMigration0016,
  runMigration0017,
  columnExists,
} from "./migrations-sql";
export type { Migration, MigrationStorage } from "./migrations-sql";

// Ops modules -- namespace exports for consumer convenience
export * as entityOps from "./entity-ops";
export * as coordinationOps from "./coordination-ops";
export * as artifactOps from "./artifact-ops";
export * as journalOps from "./journal-ops";
export * as journalArchiveOps from "./journal-archive-ops";
export * as schemaOps from "./schema-ops";
export * as relationshipOps from "./relationship-ops";
export * as constraintOps from "./constraint-ops";
export * as searchDriftOps from "./search-drift-ops";
export * as sweepOps from "./sweep-ops";
export * as readyOps from "./ready-ops";
export * as gateOps from "./gate-ops";
export * as signalOps from "./signal-ops";
export * as recordOps from "./record-ops";
export * as fenceOps from "./fence-ops";
export * as searchReindexOps from "./search-reindex-ops";
export * as storeCountsOps from "./store-counts-ops";

// Named type exports for downstream consumers
export type { EnrichOpts } from "./entity-ops";
export type { SweepResult } from "./sweep-ops";
export type {
  SendSignalParams,
  SendSignalResult,
  AckSignalResult,
} from "./signal-ops";
export type { ApplySchemaResult } from "./schema-ops";
export type {
  AcquireResult,
  RenewResult,
  PresenceWithStatus,
} from "./coordination-ops";
export type {
  ConstraintViolation,
  SearchabilityResult,
} from "./constraint-ops";
export type { GateRow, CreateGateParams } from "./gate-ops";
export type { RequestOrigin } from "./journal-ops";
export type {
  RecordRow,
  RecordListItem,
  RecordHistoryItem,
} from "./record-ops";

// Utility helpers
export { entitySearchText } from "./entity-search-text";

// Error classes (re-exported for consumer use)
export { EntityAlreadyExistsError, EntityNotFoundError } from "./entity-ops";
export { SearchQueryError, validateFtsQuery } from "./artifact-ops";
export { FenceNotFoundError } from "./fence-ops";
export {
  GateNotFoundError,
  GateAlreadySettledError,
  GateFenceError,
  GateBlockedError,
} from "./gate-ops";
export {
  RecordAlreadyExistsError,
  RecordNotFoundError,
  RecordInvalidStateError,
  RevisionNotFoundError,
  validateRecordValue,
} from "./record-ops";
