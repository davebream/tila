import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { truncateAllDomainTables } from "../src/destroy-ops";
import { DOMAIN_TABLE_NAMES, countStoreRows } from "../src/store-counts-ops";
import { type TestDb, createTestDb } from "./helpers";

let testDb: TestDb;

beforeEach(() => {
  testDb = createTestDb();
});

afterEach(() => {
  testDb.rawDb.close();
});

// A RawSqlExecutor backed by the test's better-sqlite3 handle — mirrors the DO's
// ctx.storage.sql seam (a single exec(statement) method).
function rawExecutor(rawDb: TestDb["rawDb"]) {
  return {
    exec(statement: string) {
      rawDb.exec(statement);
    },
  };
}

// Tables a project destroy intentionally leaves alone or clears separately:
// migration bookkeeping, DO-only request dedup, the transfer lock, and the FTS5
// virtual tables (plus their shadow tables), which the *_search_docs triggers clean.
const NON_DOMAIN_TABLES = new Set([
  "_migrations",
  "_schema_history",
  "_do_idempotency",
  "_project_transfer_state",
  "_project_transfer_chunks",
]);

function migratedTableNames(rawDb: TestDb["rawDb"]): string[] {
  return (
    rawDb
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as { name: string }[]
  )
    .map((row) => row.name)
    .filter(
      (name) =>
        !name.startsWith("sqlite_") &&
        !/_fts($|_)/.test(name) &&
        !NON_DOMAIN_TABLES.has(name),
    )
    .sort();
}

function rowCount(rawDb: TestDb["rawDb"], table: string): number {
  return (
    rawDb.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as {
      n: number;
    }
  ).n;
}

describe("truncateAllDomainTables", () => {
  it("lists every migrated domain table (drift guard)", () => {
    expect([...DOMAIN_TABLE_NAMES].sort()).toEqual(
      migratedTableNames(testDb.rawDb),
    );
  });

  it("commits and empties tasks with queued work, questions and report receipts", () => {
    const now = Date.now();
    const insert = (statement: string) => testDb.rawDb.prepare(statement).run();
    insert(
      `INSERT INTO entities(id, type, schema_version, data, archived, created_at, updated_at, created_by)
       VALUES('e-1', 'task', 1, '{}', 0, ${now}, ${now}, 'test-actor')`,
    );
    insert(
      `INSERT INTO queue_entries(id, task_id, state, priority, enqueue_order, required_capabilities, retry_policy, available_at, created_at, updated_at)
       VALUES('qe-1', 'e-1', 'admitted', 0, 1, '[]', '{}', ${now}, ${now}, ${now})`,
    );
    insert(
      `INSERT INTO work_attempts(id, entry_id, task_id, resource, principal_id, participant_id, state, fence, created_at, updated_at)
       VALUES('wa-1', 'qe-1', 'e-1', 'task:e-1', 'worker', 'worker-host', 'running', 1, ${now}, ${now})`,
    );
    insert(
      `INSERT INTO work_questions(id, task_id, attempt_id, requester_principal_id, responder_principal_id, state, snapshot)
       VALUES('wq-1', 'e-1', 'wa-1', 'worker', 'orchestrator', 'open', '{}')`,
    );
    insert(
      `INSERT INTO question_receipts(key, request, question_id, result, created_at)
       VALUES('qr-1', '{}', 'wq-1', '{}', ${now})`,
    );
    insert(
      `INSERT INTO journal_report_receipts(key, project_id, principal_id, participant_id, request_hash, response, expires_at)
       VALUES('jr-1', 'p-1', 'worker', 'worker-host', 'hash', '{}', ${now + 1000})`,
    );
    insert(
      `INSERT INTO journal_report_rates(key, window_start, count)
       VALUES('worker', ${now}, 1)`,
    );

    // A DO request runs inside one implicit transaction; deferred FK checks fire
    // at commit, so the whole truncate must commit cleanly.
    expect(() =>
      testDb.rawDb.transaction(() =>
        truncateAllDomainTables(rawExecutor(testDb.rawDb)),
      )(),
    ).not.toThrow();

    for (const table of migratedTableNames(testDb.rawDb)) {
      expect(
        rowCount(testDb.rawDb, table),
        `expected ${table} to be empty`,
      ).toBe(0);
    }
  });

  it("empties every domain table and _schema_history", () => {
    const now = Date.now();
    // Seed a spread of domain tables.
    testDb.rawDb
      .prepare(
        `INSERT INTO entities(id, type, schema_version, data, archived, created_at, updated_at, created_by)
         VALUES('e-1', 'task', 1, '{}', 0, ${now}, ${now}, 'test-actor')`,
      )
      .run();
    testDb.rawDb
      .prepare(
        `INSERT INTO fences(resource, current_fence) VALUES('task:e-1', 2)`,
      )
      .run();
    testDb.rawDb
      .prepare(
        `INSERT INTO claims(resource, principal_id, participant_id, environment, mode, fence, acquired_at, expires_at, metadata)
         VALUES('task:e-1', 'u', 'm', '{}', 'exclusive', 2, ${now}, ${now + 1000}, '{}')`,
      )
      .run();
    testDb.rawDb
      .prepare(
        `INSERT INTO presence(principal_id, participant_id, environment, last_seen, info)
         VALUES('u', 'm', '{}', ${now}, '{}')`,
      )
      .run();
    // Seed a _schema_history row: destroy must also clear migration bookkeeping.
    testDb.rawDb
      .prepare(
        `INSERT INTO _schema_history(version, definition, applied_at, applied_by)
         VALUES(1, '{}', ${now}, 'test-actor')`,
      )
      .run();
    expect(countStoreRows(testDb.db).schemaHistory).toBeGreaterThan(0);

    truncateAllDomainTables(rawExecutor(testDb.rawDb));

    const result = countStoreRows(testDb.db);
    for (const table of DOMAIN_TABLE_NAMES) {
      expect(result.domain[table], `expected ${table} to be empty`).toBe(0);
    }
    expect(result.schemaHistory).toBe(0);
  });

  it("keeps the schema intact (tables still queryable after truncation)", () => {
    truncateAllDomainTables(rawExecutor(testDb.rawDb));

    // If truncation had dropped tables, countStoreRows would throw on the missing
    // table. A clean all-zero read proves the schema is intact.
    const result = countStoreRows(testDb.db);
    for (const table of DOMAIN_TABLE_NAMES) {
      expect(result.domain[table]).toBe(0);
    }
  });
});
