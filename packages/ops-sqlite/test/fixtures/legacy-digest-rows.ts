/**
 * Fixed rows for the pre-0.8 semantic-digest regression oracle.
 *
 * This module is dependency-free on purpose: the same file is loaded by the
 * v0.7.0 generator (see `scripts/generate-legacy-backup-fixtures.mjs`) and by
 * the current test, so both digests are computed over byte-identical rows.
 * Columns are limited to those that exist at migration level 40.
 */

export type LegacyDigestRow = Record<string, string | number | null>;

/** Insertion order satisfies the level-40 foreign keys. */
export const LEGACY_DIGEST_ROWS: ReadonlyArray<{
  table: string;
  rows: ReadonlyArray<LegacyDigestRow>;
}> = [
  {
    table: "agents",
    rows: [
      {
        id: "worker",
        name: "Worker",
        owner_principal_id: "owner",
        bind_policy: "[]",
        binding_epoch: 0,
        archived: 0,
        created_at: 1_000,
        updated_at: 1_000,
      },
    ],
  },
  {
    table: "entities",
    rows: [
      {
        id: "legacy-task",
        type: "task",
        schema_version: 1,
        data: '{"name":"Legacy task","status":"open"}',
        archived: 0,
        created_at: 1_000,
        updated_at: 1_000,
        created_by: "fixture",
      },
    ],
  },
  {
    table: "artifact_lineages",
    rows: [
      {
        id: "lineage-1",
        project_id: "legacy-archive",
        kind: "report",
        resource: "legacy-task",
        next_revision: 2,
        destroyed_at: null,
      },
    ],
  },
  {
    table: "artifact_pointers",
    rows: [
      {
        r2_key:
          "produced/legacy-task/2acbddfed457df05216446e61c4bfeb596deea42c70a872121899669297a6038.txt",
        resource: "legacy-task",
        kind: "report",
        sha256:
          "2acbddfed457df05216446e61c4bfeb596deea42c70a872121899669297a6038",
        bytes: 15,
        fence: null,
        mime_type: "text/plain",
        produced_at: 1_000,
        produced_by: "fixture",
        expires_at: null,
        tombstoned: 0,
        content_inline: null,
        tombstoned_at: null,
        blob_deleted_at: null,
        lineage_id: "lineage-1",
        revision: 1,
        restored_from: null,
        provenance: null,
        revision_creation: null,
      },
    ],
  },
  {
    table: "artifact_revisions",
    rows: [
      {
        r2_key:
          "produced/legacy-task/2acbddfed457df05216446e61c4bfeb596deea42c70a872121899669297a6038.txt",
        lineage_id: "lineage-1",
        revision: 1,
        metadata: "{}",
        retention_assigned: 0,
      },
    ],
  },
  {
    table: "artifact_reviews",
    rows: [
      {
        artifact_key:
          "produced/legacy-task/2acbddfed457df05216446e61c4bfeb596deea42c70a872121899669297a6038.txt",
        review_revision: 1,
        principal_id: "reviewer",
        participant_id: "reviewer-1",
        created_at: 1_000,
        decision: "trusted",
        reason: "Checked source",
        operation_id: "review-op-1",
        request_json:
          '{"decision":"trusted","expected_review_revision":0,"reason":"Checked source"}',
      },
    ],
  },
  {
    table: "records",
    rows: [
      {
        type: "config",
        key: "main",
        schema_version: 1,
        value_json: '{"region":"eu"}',
        value_sha256:
          "8d92cf62e5a32863635c4e57fcbea607f59fe146781d8d4aede5c835438e09e8",
        revision: 1,
        archived: 0,
        created_at: 1_000,
        updated_at: 1_000,
        updated_by: "fixture",
      },
    ],
  },
  {
    // Sits after `records` in both digest orders; pins that `records` did not
    // move past it.
    table: "_schema_history",
    rows: [
      {
        version: 1,
        definition: '{"types":{}}',
        applied_at: 1_000,
        applied_by: "fixture",
        change_summary: null,
        strategy: null,
      },
    ],
  },
  {
    table: "fences",
    rows: [{ resource: "task:legacy-task", current_fence: 3 }],
  },
];

/** Minimal better-sqlite3-compatible surface so this file needs no imports. */
export interface LegacyRowTarget {
  prepare(statement: string): { run(...values: unknown[]): unknown };
}

/** Inserts the fixed rows, or only those of `tables` when given. */
export function insertLegacyDigestRows(
  target: LegacyRowTarget,
  tables?: readonly string[],
): void {
  for (const { table, rows } of LEGACY_DIGEST_ROWS) {
    if (tables && !tables.includes(table)) continue;
    for (const row of rows) {
      const columns = Object.keys(row);
      target
        .prepare(
          `INSERT INTO "${table}" (${columns.map((c) => `"${c}"`).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
        )
        .run(...columns.map((column) => row[column]));
    }
  }
}
