import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLocalConnection } from "../../src/connection";
import { LocalProject } from "../../src/local-project";

describe("sqlite-busy-retry: real SQLITE_BUSY handling", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "tila-busy-"));
    dbPath = join(tempDir, "busy.db");

    // Pre-create the database with migrations
    const lp = LocalProject.open(dbPath, "test-org", "test-project", {
      skipFilesystemCheck: true,
    });
    lp.close();
  });

  afterEach(() => {
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it(
    "generates real SQLITE_BUSY with two connections and busy_timeout=0",
    () => {
      // Connection 1: hold a write lock via BEGIN IMMEDIATE
      const conn1 = new Database(dbPath);
      conn1.exec("PRAGMA journal_mode=WAL;");
      conn1.exec("PRAGMA busy_timeout=0;");
      conn1.exec("BEGIN IMMEDIATE");

      // Connection 2: attempt a write -- should get SQLITE_BUSY immediately
      const conn2 = new Database(dbPath);
      conn2.exec("PRAGMA journal_mode=WAL;");
      conn2.exec("PRAGMA busy_timeout=0;"); // No wait -- fail immediately

      expect(() => {
        conn2.exec("BEGIN IMMEDIATE");
      }).toThrow(/SQLITE_BUSY|database is locked/);

      // Clean up
      conn1.exec("ROLLBACK");
      conn1.close();
      conn2.close();
    },
    { timeout: 15000 },
  );

  it(
    "createLocalConnection applies busy_timeout on reconnect",
    () => {
      // Verifies that createLocalConnection consistently applies busy_timeout
      const db = createLocalConnection(dbPath, "test-org", "test-project", {
        skipFilesystemCheck: true,
      });
      // bun:sqlite returns PRAGMA busy_timeout result with key "timeout"
      const timeout = db.$client.query("PRAGMA busy_timeout").get() as {
        timeout: number;
      };
      expect(timeout.timeout).toBeGreaterThanOrEqual(5000);
      db.$client.close();
    },
    { timeout: 15000 },
  );
});
