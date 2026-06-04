import type { ArtifactKind, TilaSchemaToml } from "@tila/schemas";
import { sql } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import type * as schemaModule from "./schema";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DriftFinding {
  check: string;
  status: "pass" | "warn" | "fail";
  count: number;
  detail: string;
  examples: string[];
}

interface DriftReport {
  findings: DriftFinding[];
  checkedAt: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const EXAMPLE_LIMIT = 5;
const QUERY_LIMIT = 100;

function schemaUnavailableSentinel(check: string): DriftFinding {
  return {
    check,
    status: "warn",
    count: 0,
    detail: "Schema unavailable -- check skipped",
    examples: [],
  };
}

/**
 * Returns kinds where searchable=true from the schema's artifacts section.
 * Uses schema.artifacts (not artifact_kinds) per TilaSchemaToml type.
 */
function getSearchableKinds(schema: TilaSchemaToml): string[] {
  const kinds: string[] = [];
  for (const [name, def] of Object.entries(schema.artifacts ?? {}) as Array<
    [string, ArtifactKind]
  >) {
    if (def.searchable) {
      kinds.push(name);
    }
  }
  return kinds;
}

/**
 * Returns kinds where searchable is false or absent from the schema's artifacts section.
 */
function getNonSearchableKinds(schema: TilaSchemaToml): string[] {
  const kinds: string[] = [];
  for (const [name, def] of Object.entries(schema.artifacts ?? {}) as Array<
    [string, ArtifactKind]
  >) {
    if (!def.searchable) {
      kinds.push(name);
    }
  }
  return kinds;
}

// ---------------------------------------------------------------------------
// Individual checks
// ---------------------------------------------------------------------------

/**
 * check 1: search-missing-doc
 * Searchable artifact pointers without a corresponding search doc entry.
 * Severity: fail
 */
function checkMissingDoc(
  db: BaseSQLiteDatabase<"sync", unknown, typeof schemaModule>,
  parsedSchema: TilaSchemaToml | null,
): DriftFinding {
  if (!parsedSchema) return schemaUnavailableSentinel("search-missing-doc");
  const searchableKinds = getSearchableKinds(parsedSchema);
  if (searchableKinds.length === 0) {
    return {
      check: "search-missing-doc",
      status: "pass",
      count: 0,
      detail: "No searchable artifact kinds declared",
      examples: [],
    };
  }
  const kindParams = searchableKinds.map((k) => sql`${k}`);
  const inClause = sql.join(kindParams, sql`, `);
  const rows = db.all<{ r2_key: string }>(sql`
    SELECT ap.r2_key FROM artifact_pointers ap
    LEFT JOIN artifact_search_docs asd ON ap.r2_key = asd.artifact_key
    WHERE ap.tombstoned = 0
      AND asd.artifact_key IS NULL
      AND ap.kind IN (${inClause})
    LIMIT ${QUERY_LIMIT}
  `);
  const count = rows.length;
  return {
    check: "search-missing-doc",
    status: count > 0 ? "fail" : "pass",
    count,
    detail:
      count > 0
        ? `${count} searchable artifact(s) missing search doc entry`
        : "All searchable artifacts have search docs",
    examples: rows.slice(0, EXAMPLE_LIMIT).map((r) => r.r2_key),
  };
}

/**
 * check 2: search-orphan-doc
 * Search doc rows with no corresponding artifact_pointers row.
 * Severity: fail
 */
function checkOrphanDoc(
  db: BaseSQLiteDatabase<"sync", unknown, typeof schemaModule>,
): DriftFinding {
  const rows = db.all<{ artifact_key: string }>(sql`
    SELECT asd.artifact_key FROM artifact_search_docs asd
    LEFT JOIN artifact_pointers ap ON asd.artifact_key = ap.r2_key
    WHERE ap.r2_key IS NULL
    LIMIT ${QUERY_LIMIT}
  `);
  const count = rows.length;
  return {
    check: "search-orphan-doc",
    status: count > 0 ? "fail" : "pass",
    count,
    detail:
      count > 0
        ? `${count} search doc(s) have no corresponding artifact pointer`
        : "No orphaned search docs",
    examples: rows.slice(0, EXAMPLE_LIMIT).map((r) => r.artifact_key),
  };
}

/**
 * check 3: search-tombstone-leak
 * Search docs visible (tombstoned=0) for tombstoned artifacts (tombstoned=1).
 * Severity: fail
 */
function checkTombstoneLeak(
  db: BaseSQLiteDatabase<"sync", unknown, typeof schemaModule>,
): DriftFinding {
  const rows = db.all<{ artifact_key: string }>(sql`
    SELECT asd.artifact_key FROM artifact_search_docs asd
    JOIN artifact_pointers ap ON asd.artifact_key = ap.r2_key
    WHERE ap.tombstoned = 1 AND asd.tombstoned = 0
    LIMIT ${QUERY_LIMIT}
  `);
  const count = rows.length;
  return {
    check: "search-tombstone-leak",
    status: count > 0 ? "fail" : "pass",
    count,
    detail:
      count > 0
        ? `${count} search doc(s) visible for tombstoned artifacts`
        : "No tombstone leaks",
    examples: rows.slice(0, EXAMPLE_LIMIT).map((r) => r.artifact_key),
  };
}

/**
 * check 4: search-unsupported-kind
 * Search docs for artifact kinds not marked searchable=true in schema.
 * Severity: warn (indexed but shouldn't be; no data loss)
 */
function checkUnsupportedKind(
  db: BaseSQLiteDatabase<"sync", unknown, typeof schemaModule>,
  parsedSchema: TilaSchemaToml | null,
): DriftFinding {
  if (!parsedSchema)
    return schemaUnavailableSentinel("search-unsupported-kind");
  const nonSearchableKinds = getNonSearchableKinds(parsedSchema);
  if (nonSearchableKinds.length === 0) {
    return {
      check: "search-unsupported-kind",
      status: "pass",
      count: 0,
      detail: "All declared kinds are searchable",
      examples: [],
    };
  }
  const kindParams = nonSearchableKinds.map((k) => sql`${k}`);
  const inClause = sql.join(kindParams, sql`, `);
  const rows = db.all<{ artifact_key: string }>(sql`
    SELECT asd.artifact_key FROM artifact_search_docs asd
    WHERE asd.kind IN (${inClause})
    LIMIT ${QUERY_LIMIT}
  `);
  const count = rows.length;
  return {
    check: "search-unsupported-kind",
    status: count > 0 ? "warn" : "pass",
    count,
    detail:
      count > 0
        ? `${count} search doc(s) for non-searchable artifact kinds`
        : "No search docs for unsupported kinds",
    examples: rows.slice(0, EXAMPLE_LIMIT).map((r) => r.artifact_key),
  };
}

/**
 * check 5: search-stale-index
 * Search docs where source_sha256 differs from artifact_pointers.sha256.
 * Severity: warn (stale but present; T11 reconcile will fix)
 */
function checkStaleIndex(
  db: BaseSQLiteDatabase<"sync", unknown, typeof schemaModule>,
): DriftFinding {
  const rows = db.all<{ artifact_key: string }>(sql`
    SELECT asd.artifact_key FROM artifact_search_docs asd
    JOIN artifact_pointers ap ON asd.artifact_key = ap.r2_key
    WHERE asd.source_sha256 != ap.sha256
      AND ap.tombstoned = 0
    LIMIT ${QUERY_LIMIT}
  `);
  const count = rows.length;
  return {
    check: "search-stale-index",
    status: count > 0 ? "warn" : "pass",
    count,
    detail:
      count > 0
        ? `${count} search doc(s) with stale sha256 (source differs from pointer)`
        : "All search docs are up to date",
    examples: rows.slice(0, EXAMPLE_LIMIT).map((r) => r.artifact_key),
  };
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Computes all five drift checks against artifact_search_docs and
 * artifact_pointers. Returns a DriftReport with findings for each check.
 *
 * If artifact_search_docs table is absent (T2/T10 migration not applied),
 * returns warn sentinels for all checks rather than throwing.
 *
 * If parsedSchema is null, schema-dependent checks (missing-doc,
 * unsupported-kind) return a schema-unavailable sentinel. The remaining
 * three checks run normally.
 */
export function computeDrift(
  db: BaseSQLiteDatabase<"sync", unknown, typeof schemaModule>,
  parsedSchema: TilaSchemaToml | null,
): DriftReport {
  try {
    const findings: DriftFinding[] = [
      checkMissingDoc(db, parsedSchema),
      checkOrphanDoc(db),
      checkTombstoneLeak(db),
      checkUnsupportedKind(db, parsedSchema),
      checkStaleIndex(db),
    ];
    return { findings, checkedAt: Date.now() };
  } catch (err) {
    // Table missing (T2/migration not applied) -- return warn sentinels for all checks
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("no such table")) {
      const checks = [
        "search-missing-doc",
        "search-orphan-doc",
        "search-tombstone-leak",
        "search-unsupported-kind",
        "search-stale-index",
      ];
      return {
        findings: checks.map((check) => ({
          check,
          status: "warn" as const,
          count: 0,
          detail:
            "artifact_search_docs table not found -- search schema not applied",
          examples: [],
        })),
        checkedAt: Date.now(),
      };
    }
    throw err;
  }
}
