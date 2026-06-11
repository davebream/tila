// packages/core/src/interfaces/record-backend.ts

import type {
  RecordHistoryItem,
  RecordListItem,
  RecordRow,
} from "@tila/schemas";

export interface CreateRecordInput {
  type: string;
  key: string;
  value: Record<string, unknown>;
  tags?: string[];
  message?: string | null;
  sourceArtifactKey?: string | null;
}

export interface SetRecordInput {
  type: string;
  key: string;
  value: Record<string, unknown>;
  fence: number;
  tags?: string[];
  message?: string | null;
  sourceArtifactKey?: string | null;
}

export interface PutRecordInput {
  type: string;
  key: string;
  value: Record<string, unknown>;
  tags?: string[];
  message?: string | null;
  sourceArtifactKey?: string | null;
}

export interface PatchRecordInput {
  type: string;
  key: string;
  patch: Record<string, unknown>;
  fence: number;
  message?: string | null;
}

export interface ArchiveRecordInput {
  type: string;
  key: string;
  fence: number;
  message?: string | null;
}

export interface RecordListFilter {
  type: string;
  includeArchived?: boolean;
  tag?: string;
  tagFilter?: string[];
  dataFilter?: Record<string, unknown>;
  limit?: number;
}

export interface RecordHistoryOptions {
  limit?: number;
  includeValues?: boolean;
}

export interface RecordPage<T> {
  items: T[];
  total: number;
  next_cursor: string | null;
}

/**
 * Backend contract for typed mutable records (see `docs/08-RECORDS.md`).
 *
 * Part of the CLI local/remote backend-swap seam (see this directory's
 * `README.md`). The CLI resolves either a remote (HTTP → Worker) or local
 * (`@tila/backend-local`) implementation at startup and calls these methods
 * uniformly.
 *
 * ## Input casing — camelCase boundary
 *
 * Input keys on this interface are **camelCase** (`sourceArtifactKey`), matching
 * the plan's required surface. The ops/DB layer (`@tila/ops-sqlite`) uses
 * **snake_case** (`source_artifact_key`). Each backend implementation is
 * responsible for translating camelCase input keys to the snake_case ops/DB
 * layer at its boundary; callers of this interface only ever see camelCase.
 *
 * ## Why `schema_version`/`actor`/`origin`/`canonical_artifact_key` are NOT inputs
 *
 * Unlike `EntityBackend`/`SignalBackend` (which thread `actor` through their
 * inputs), this interface intentionally OMITS `schema_version`, `actor`,
 * `origin`, and `canonical_artifact_key` from the input shapes. This is a
 * deliberate design decision from the plan, not an oversight: each backend
 * resolves these itself (remote resolves actor from the auth token; local
 * resolves it from machine/session context; both derive `schema_version` and
 * `canonical_artifact_key` from the record/schema state). Threading them through
 * the caller would let callers forge an actor or desync the schema version.
 *
 * The return types are NOT abstracted: `RecordRow` carries the `fence`, and
 * `RecordHistoryItem` carries the read-only
 * `schema_version`/`actor`/`canonical_artifact_key` output fields.
 *
 * The record types are the canonical schema types from `@tila/schemas`; never
 * import them from `@tila/ops-sqlite` (that would invert the dependency flow).
 */
export interface RecordBackend {
  createRecord(input: CreateRecordInput): Promise<RecordRow>;
  setRecord(input: SetRecordInput): Promise<RecordRow>;
  putRecord(input: PutRecordInput): Promise<RecordRow>;
  getRecord(type: string, key: string): Promise<RecordRow | null>;
  patchRecord(input: PatchRecordInput): Promise<RecordRow>;
  archiveRecord(input: ArchiveRecordInput): Promise<RecordRow>;
  unarchiveRecord(input: ArchiveRecordInput): Promise<RecordRow>;
  listRecords(filter: RecordListFilter): Promise<RecordPage<RecordListItem>>;
  listRecordHistory(
    type: string,
    key: string,
    opts?: RecordHistoryOptions,
  ): Promise<RecordPage<RecordHistoryItem>>;
  /**
   * Record types that are currently IN USE — i.e. types with at least one
   * active (non-archived) record — sorted and distinct.
   *
   * This is the in-use subset ONLY. It does NOT include schema-declared types
   * that have no records yet. Every implementation must honour this contract so
   * local and remote backends agree (the remote backend returns the Worker's
   * `in_use_types`). Callers that need the merged "declared ∪ in-use" view
   * (e.g. CLI `record types` without `--in-use`) compose it from the schema's
   * declared types unioned with this method's result.
   */
  listRecordTypesInUse(): Promise<string[]>;
}
