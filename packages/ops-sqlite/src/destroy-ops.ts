import { DOMAIN_TABLE_NAMES } from "./store-counts-ops";

/**
 * Minimal raw-SQL executor seam.
 *
 * Project destroy operates *below* Drizzle: it must truncate every domain table
 * plus `_schema_history` in one pass, including tables that have no Drizzle model
 * involvement in the delete order. On a SQLite-backed Durable Object this is
 * `ctx.storage.sql`; in tests it is a thin wrapper over the raw driver. We only
 * need a single `exec(statement)` method, so the seam stays intentionally tiny.
 */
export interface RawSqlExecutor {
  exec(statement: string): unknown;
}

/**
 * Truncate every domain table (and `_schema_history`) for a project destroy.
 *
 * We must NOT use `deleteAll()` on a SQLite-backed DO: it drops the SQL tables,
 * which leaves the schema broken (migrations think they have already run) and
 * corrupts the object. Deleting rows keeps the schema intact.
 *
 * `defer_foreign_keys = ON` allows any delete order within the implicit
 * transaction; deleting the `*_search_docs` base tables fires the FTS5 cleanup
 * triggers, so the virtual `*_fts` tables are cleaned up too.
 *
 * The caller is responsible for the transactional/output-gate semantics (e.g. a
 * DO route must return normally rather than `ctx.abort()`, so the deletes durably
 * commit).
 */
export function truncateAllDomainTables(rawSql: RawSqlExecutor): void {
  rawSql.exec("PRAGMA defer_foreign_keys = ON");
  for (const table of DOMAIN_TABLE_NAMES) {
    rawSql.exec(`DELETE FROM "${table}"`);
  }
  rawSql.exec("DELETE FROM _schema_history");
}
