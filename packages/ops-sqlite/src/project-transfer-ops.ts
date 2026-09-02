import type { ProjectTransferMode, ProjectTransferState } from "@tila/schemas";

export interface SqlRows<T = Record<string, unknown>> {
  toArray(): T[];
}

export interface ProjectSqlStorage {
  exec(statement: string, ...bindings: unknown[]): SqlRows;
}

export const PROJECT_BACKUP_TABLES = [
  "entities",
  "artifact_pointers",
  "records",
  "_schema_history",
  "claims",
  "fences",
  "presence",
  "gates",
  "signals",
  "journal",
  "_journal_archive_watermark",
  "entity_relationships",
  "entity_artifact_references",
  "artifact_relationships",
  "entity_tags",
  "artifact_tags",
  "record_tags",
  "record_revisions",
  "artifact_search_docs",
  "entity_search_docs",
  "record_search_docs",
] as const;

export type ProjectBackupTable = (typeof PROJECT_BACKUP_TABLES)[number];

const PRIMARY_KEYS: Record<ProjectBackupTable, readonly string[]> = {
  entities: ["id"],
  artifact_pointers: ["r2_key"],
  records: ["type", "key"],
  _schema_history: ["version"],
  claims: ["resource"],
  fences: ["resource"],
  presence: ["principal_id", "participant_id"],
  gates: ["id"],
  signals: ["id"],
  journal: ["seq"],
  _journal_archive_watermark: ["id"],
  entity_relationships: ["from_id", "to_id", "type"],
  entity_artifact_references: ["entity_id", "artifact_key", "slot"],
  artifact_relationships: ["from_key", "target", "type"],
  entity_tags: ["entity_id", "tag"],
  artifact_tags: ["artifact_key", "tag"],
  record_tags: ["type", "key", "tag"],
  record_revisions: ["type", "key", "revision"],
  artifact_search_docs: ["artifact_key"],
  entity_search_docs: ["entity_id"],
  record_search_docs: ["record_type", "record_key"],
};

export class ProjectMaintenanceError extends Error {
  readonly code = "project-maintenance";

  constructor(public readonly state: ProjectTransferState) {
    super(`Project is locked for ${state.mode}`);
    this.name = "ProjectMaintenanceError";
  }
}

export class TransferConflictError extends Error {
  readonly code = "transfer-conflict";
}

function assertTable(table: string): asserts table is ProjectBackupTable {
  if (!PROJECT_BACKUP_TABLES.includes(table as ProjectBackupTable)) {
    throw new Error(`Unsupported project backup table: ${table}`);
  }
}

export function tableExists(sql: ProjectSqlStorage, table: string): boolean {
  return (
    sql
      .exec(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
        table,
      )
      .toArray().length > 0
  );
}

export function readSnapshotPage(
  sql: ProjectSqlStorage,
  table: ProjectBackupTable,
  options: { offset?: number; limit?: number } = {},
): { rows: Record<string, unknown>[]; nextOffset: number | null } {
  assertTable(table);
  if (!tableExists(sql, table)) return { rows: [], nextOffset: null };
  const offset = Math.max(0, options.offset ?? 0);
  const limit = Math.min(1_000, Math.max(1, options.limit ?? 250));
  const order = PRIMARY_KEYS[table].map((key) => `"${key}"`).join(", ");
  const rows = sql
    .exec(
      `SELECT * FROM "${table}" ORDER BY ${order} LIMIT ? OFFSET ?`,
      limit + 1,
      offset,
    )
    .toArray() as Record<string, unknown>[];
  const hasMore = rows.length > limit;
  if (hasMore) rows.pop();
  return { rows, nextOffset: hasMore ? offset + rows.length : null };
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`;
}

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes =
    typeof data === "string" ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new Uint8Array(bytes).buffer,
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function semanticDigest(sql: ProjectSqlStorage): Promise<string> {
  const sections: string[] = [];
  for (const table of PROJECT_BACKUP_TABLES) {
    let offset: number | null = 0;
    while (offset !== null) {
      const page = readSnapshotPage(sql, table, { offset, limit: 500 });
      for (const row of page.rows)
        sections.push(`${table}\0${canonicalJson(row)}\n`);
      offset = page.nextOffset;
    }
  }
  return sha256Hex(sections.join(""));
}

export function journalState(sql: ProjectSqlStorage): {
  nextSequence: number;
  archiveWatermark: number;
} {
  const max = sql
    .exec("SELECT COALESCE(MAX(seq), 0) AS value FROM journal")
    .toArray()[0] as { value: number } | undefined;
  const sequence = tableExists(sql, "sqlite_sequence")
    ? (sql
        .exec("SELECT seq AS value FROM sqlite_sequence WHERE name = 'journal'")
        .toArray()[0] as { value: number } | undefined)
    : undefined;
  const watermark = tableExists(sql, "_journal_archive_watermark")
    ? (sql
        .exec(
          "SELECT last_archived_seq AS value FROM _journal_archive_watermark WHERE id = 1",
        )
        .toArray()[0] as { value: number } | undefined)
    : undefined;
  return {
    nextSequence:
      Math.max(max?.value ?? 0, sequence?.value ?? 0, watermark?.value ?? 0) +
      1,
    archiveWatermark: watermark?.value ?? 0,
  };
}

export function replaceSnapshotRows(
  sql: ProjectSqlStorage,
  tables: Partial<Record<ProjectBackupTable, Record<string, unknown>[]>>,
  journalNextSequence: number,
): void {
  clearSnapshotRows(sql);
  for (const table of PROJECT_BACKUP_TABLES) {
    insertSnapshotRows(sql, table, tables[table] ?? []);
  }
  finalizeSnapshotRestore(sql, journalNextSequence);
}

export function clearSnapshotRows(sql: ProjectSqlStorage): void {
  sql.exec(
    "UPDATE _project_transfer_state SET applying = 1 WHERE singleton = 1",
  );
  sql.exec("PRAGMA defer_foreign_keys = ON");
  for (const table of [...PROJECT_BACKUP_TABLES].reverse()) {
    if (tableExists(sql, table)) sql.exec(`DELETE FROM "${table}"`);
  }
}

export function prepareSnapshotRestore(
  sql: ProjectSqlStorage,
  sessionId: string,
): "prepared" | "replayed" {
  const state = getTransferState(sql);
  if (!state || state.session_id !== sessionId || state.mode === "export") {
    throw new TransferConflictError(
      "Import session does not match the active lock",
    );
  }
  const row = sql
    .exec("SELECT applying FROM _project_transfer_state WHERE singleton = 1")
    .toArray()[0] as { applying: number } | undefined;
  if (row?.applying === 1) return "replayed";
  clearSnapshotRows(sql);
  return "prepared";
}

export function insertSnapshotRows(
  sql: ProjectSqlStorage,
  table: ProjectBackupTable,
  rows: Record<string, unknown>[],
): void {
  assertTable(table);
  if (!tableExists(sql, table)) return;
  const available = new Set(
    (
      sql.exec(`PRAGMA table_info("${table}")`).toArray() as { name: string }[]
    ).map(({ name }) => name),
  );
  for (const row of rows) {
    const columns = Object.keys(row).filter((column) => available.has(column));
    if (columns.length === 0) continue;
    const quoted = columns.map((column) => `"${column}"`).join(", ");
    const values = columns.map((column) => row[column]);
    sql.exec(
      `INSERT INTO "${table}" (${quoted}) VALUES (${columns.map(() => "?").join(", ")})`,
      ...values,
    );
  }
}

export function finalizeSnapshotRestore(
  sql: ProjectSqlStorage,
  journalNextSequence: number,
): void {
  if (tableExists(sql, "sqlite_sequence")) {
    sql.exec("DELETE FROM sqlite_sequence WHERE name = 'journal'");
    sql.exec(
      "INSERT INTO sqlite_sequence(name, seq) VALUES ('journal', ?)",
      journalNextSequence - 1,
    );
  }
  rebuildSearchIndexes(sql);
  sql.exec("PRAGMA defer_foreign_keys = OFF");
  sql.exec(
    "UPDATE _project_transfer_state SET applying = 0 WHERE singleton = 1",
  );
}

export function rebuildSearchIndexes(sql: ProjectSqlStorage): void {
  for (const table of [
    "artifact_search_docs_fts",
    "entity_search_docs_fts",
    "record_search_docs_fts",
  ]) {
    if (tableExists(sql, table))
      sql.exec(`INSERT INTO "${table}"("${table}") VALUES ('rebuild')`);
  }
}

function rowToState(row: Record<string, unknown>): ProjectTransferState {
  return {
    session_id: String(row.session_id),
    mode: row.mode as ProjectTransferMode,
    owner: String(row.owner),
    archive_digest:
      row.archive_digest === null ? null : String(row.archive_digest),
    safety_archive:
      row.safety_archive === null ? null : String(row.safety_archive),
    started_at: Number(row.started_at),
    updated_at: Number(row.updated_at),
    expires_at: row.expires_at === null ? null : Number(row.expires_at),
  };
}

export function getTransferState(
  sql: ProjectSqlStorage,
  now = Date.now(),
): ProjectTransferState | null {
  const row = sql
    .exec("SELECT * FROM _project_transfer_state WHERE singleton = 1")
    .toArray()[0] as Record<string, unknown> | undefined;
  if (!row) return null;
  const state = rowToState(row);
  if (
    state.mode === "export" &&
    state.expires_at !== null &&
    state.expires_at <= now
  ) {
    sql.exec(
      "DELETE FROM _project_transfer_chunks WHERE session_id = ?",
      state.session_id,
    );
    sql.exec("DELETE FROM _project_transfer_state WHERE singleton = 1");
    return null;
  }
  return state;
}

export function beginTransfer(
  sql: ProjectSqlStorage,
  input: {
    sessionId: string;
    mode: ProjectTransferMode;
    owner: string;
    archiveDigest?: string | null;
    safetyArchive?: string | null;
    ttlMs?: number;
    now?: number;
  },
): ProjectTransferState {
  const now = input.now ?? Date.now();
  const current = getTransferState(sql, now);
  if (current) {
    if (
      current.session_id === input.sessionId &&
      current.owner === input.owner &&
      current.mode === input.mode &&
      current.archive_digest === (input.archiveDigest ?? null)
    )
      return current;
    throw new TransferConflictError(
      `Project already has an active ${current.mode} session`,
    );
  }
  const expiresAt =
    input.mode === "export" ? now + (input.ttlMs ?? 60_000) : null;
  sql.exec(
    `INSERT INTO _project_transfer_state
      (singleton, session_id, mode, owner, archive_digest, safety_archive, started_at, updated_at, expires_at)
      VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)`,
    input.sessionId,
    input.mode,
    input.owner,
    input.archiveDigest ?? null,
    input.safetyArchive ?? null,
    now,
    now,
    expiresAt,
  );
  return getTransferState(sql, now) as ProjectTransferState;
}

export function renewExport(
  sql: ProjectSqlStorage,
  sessionId: string,
  ttlMs = 60_000,
  now = Date.now(),
): void {
  const state = getTransferState(sql, now);
  if (!state || state.session_id !== sessionId || state.mode !== "export") {
    throw new TransferConflictError(
      "Export session does not match the active lock",
    );
  }
  sql.exec(
    "UPDATE _project_transfer_state SET updated_at = ?, expires_at = ? WHERE singleton = 1",
    now,
    now + ttlMs,
  );
}

export function promoteTransfer(
  sql: ProjectSqlStorage,
  sessionId: string,
  mode: "import" | "rollback",
  archiveDigest: string,
  safetyArchive: string | null,
  now = Date.now(),
): void {
  const state = getTransferState(sql, now);
  if (!state || state.session_id !== sessionId || state.mode !== "export") {
    throw new TransferConflictError(
      "Export session does not match the active lock",
    );
  }
  sql.exec(
    `UPDATE _project_transfer_state
       SET mode = ?, archive_digest = ?, safety_archive = ?, updated_at = ?, expires_at = NULL
       WHERE singleton = 1`,
    mode,
    archiveDigest,
    safetyArchive,
    now,
  );
}

export function retargetTransfer(
  sql: ProjectSqlStorage,
  sessionId: string,
  archiveDigest: string,
  now = Date.now(),
): void {
  const state = getTransferState(sql, now);
  if (!state || state.session_id !== sessionId || state.mode === "export") {
    throw new TransferConflictError(
      "Import session does not match the active lock",
    );
  }
  sql.exec(
    "UPDATE _project_transfer_state SET mode = 'rollback', archive_digest = ?, updated_at = ? WHERE singleton = 1",
    archiveDigest,
    now,
  );
}

export function acceptChunk(
  sql: ProjectSqlStorage,
  input: {
    sessionId: string;
    section: string;
    chunkIndex: number;
    sha256: string;
    bytes: number;
    now?: number;
  },
): "accepted" | "replayed" {
  const state = getTransferState(sql, input.now);
  if (
    !state ||
    state.session_id !== input.sessionId ||
    state.mode === "export"
  ) {
    throw new TransferConflictError(
      "Import session does not match the active lock",
    );
  }
  const existing = sql
    .exec(
      "SELECT sha256, bytes FROM _project_transfer_chunks WHERE session_id = ? AND section = ? AND chunk_index = ?",
      input.sessionId,
      input.section,
      input.chunkIndex,
    )
    .toArray()[0] as { sha256: string; bytes: number } | undefined;
  if (existing) {
    if (existing.sha256 !== input.sha256 || existing.bytes !== input.bytes) {
      throw new TransferConflictError("Replayed chunk digest does not match");
    }
    return "replayed";
  }
  sql.exec(
    `INSERT INTO _project_transfer_chunks
      (session_id, section, chunk_index, sha256, bytes, accepted_at) VALUES (?, ?, ?, ?, ?, ?)`,
    input.sessionId,
    input.section,
    input.chunkIndex,
    input.sha256,
    input.bytes,
    input.now ?? Date.now(),
  );
  return "accepted";
}

export function finishTransfer(
  sql: ProjectSqlStorage,
  sessionId: string,
): void {
  const state = getTransferState(sql);
  if (!state || state.session_id !== sessionId) {
    throw new TransferConflictError(
      "Transfer session does not match the active lock",
    );
  }
  sql.exec(
    "DELETE FROM _project_transfer_chunks WHERE session_id = ?",
    sessionId,
  );
  sql.exec("DELETE FROM _project_transfer_state WHERE singleton = 1");
}
