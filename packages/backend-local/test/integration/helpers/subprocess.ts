/**
 * Subprocess helper for multi-process integration tests.
 *
 * Launched via Bun.spawn() by spawn-helper.ts. Reads config from env vars:
 *   TILA_OP        — operation to perform: "acquire" | "journal-append" | "acquire-hold"
 *   TILA_DB_PATH   — absolute path to the shared SQLite file
 *   TILA_ORG       — org name for LocalProject.open
 *   TILA_PROJECT   — project name for LocalProject.open
 *   TILA_RESOURCE  — resource name for acquire operations
 *   TILA_HOLDER    — holder name for claim operations
 *   TILA_SYNC_FILE — path to sync file (written when subprocess is ready)
 *   TILA_N         — number of operations (journal-append, default 3)
 *
 * Writes JSON results to stdout. Exits 0 on success, 1 on error.
 */

import { writeFileSync } from "node:fs";
import { LocalProject } from "../../../src/local-project";

const op = process.env.TILA_OP;
const dbPath = process.env.TILA_DB_PATH ?? "";
const org = process.env.TILA_ORG ?? "test-org";
const project = process.env.TILA_PROJECT ?? "test-project";
const resource = process.env.TILA_RESOURCE ?? "default-resource";
const holder = process.env.TILA_HOLDER ?? "default-holder";
const syncFile = process.env.TILA_SYNC_FILE;
const n = Number.parseInt(process.env.TILA_N ?? "3", 10);
// Allow tests to override busy_timeout (default 5000ms is too slow for fast CI retries).
// Tests can set TILA_BUSY_TIMEOUT=100 for faster retry cycles.
const busyTimeout = Number.parseInt(
  process.env.TILA_BUSY_TIMEOUT ?? "5000",
  10,
);

try {
  if (op === "acquire") {
    const lp = LocalProject.open(dbPath, org, project, {
      skipFilesystemCheck: true,
    });
    // Apply test-specific busy_timeout override (shorter timeout allows faster retries in CI)
    lp.getDb().$client.exec(`PRAGMA busy_timeout=${busyTimeout};`);
    let result: { acquired: boolean; fence: number; expires_at: number };
    try {
      result = await lp.acquire(resource, holder, holder, "exclusive", 30000);
    } catch (acquireErr) {
      // If we exhausted retries on SQLITE_BUSY, the resource is contended.
      // Treat as a non-winner: return acquired:false.
      const msg =
        acquireErr instanceof Error ? acquireErr.message : String(acquireErr);
      const causeMsg =
        acquireErr instanceof Error && acquireErr.cause instanceof Error
          ? acquireErr.cause.message
          : "";
      const isBusy =
        msg.includes("SQLITE_BUSY") ||
        msg.includes("database is locked") ||
        causeMsg.includes("SQLITE_BUSY") ||
        causeMsg.includes("database is locked");
      if (isBusy) {
        result = { acquired: false, fence: 0, expires_at: 0 };
      } else {
        throw acquireErr;
      }
    }
    console.log(JSON.stringify(result));
    lp.close();
  } else if (op === "journal-append") {
    const lp = LocalProject.open(dbPath, org, project, {
      skipFilesystemCheck: true,
    });
    // Apply test-specific busy_timeout override
    lp.getDb().$client.exec(`PRAGMA busy_timeout=${busyTimeout};`);
    const results: unknown[] = [];
    for (let i = 0; i < n; i++) {
      const entity = await lp.create({
        id: `${holder}-entity-${i}`,
        type: "task",
        data: { index: i, holder },
        created_by: holder,
      });
      results.push(entity);
    }
    console.log(JSON.stringify({ count: results.length, holder }));
    lp.close();
  } else if (op === "acquire-hold") {
    // Raw bun:sqlite transaction that stays open for crash recovery testing.
    // Uses raw Database API to hold an uncommitted transaction.
    const { Database } = await import("bun:sqlite");
    const db = new Database(dbPath, { create: true });
    db.exec("PRAGMA journal_mode=WAL;");
    db.exec("PRAGMA busy_timeout=5000;");
    db.exec("PRAGMA foreign_keys=ON;");

    // Begin an immediate transaction (holds the write lock)
    db.exec("BEGIN IMMEDIATE");

    // Insert a partial claim row (will be rolled back on SIGKILL)
    db.exec(`
      INSERT OR REPLACE INTO claims (resource, holder, machine, user, mode, fence, acquired_at, expires_at)
      VALUES ('${resource}', '${holder}', '${holder}', '${holder}', 'exclusive', 999999, ${Date.now()}, ${Date.now() + 60000})
    `);
    db.exec(`
      INSERT OR REPLACE INTO fences (resource, current_fence)
      VALUES ('${resource}', 999999)
    `);

    // Signal that we are inside the transaction
    if (syncFile) {
      writeFileSync(syncFile, "ready");
    }

    // Hold the process alive -- the parent will SIGKILL us
    Bun.sleepSync(10000);

    // If we get here (not killed), commit and exit
    db.exec("COMMIT");
    db.close();
  } else {
    console.error(`Unknown TILA_OP: ${op}`);
    process.exit(1);
  }
} catch (err) {
  console.error(
    `Subprocess error (op=${op}): ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
}
