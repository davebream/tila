import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLocalConnection } from "../../src/connection";

describe("pragma-verification: reconnect scenario", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "tila-pragma-"));
    dbPath = join(tempDir, "pragma.db");
  });

  afterEach(() => {
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it(
    "journal_mode=WAL persists across connections (file-level PRAGMA)",
    () => {
      // Connection 1: createLocalConnection applies PRAGMA journal_mode=WAL
      const db1 = createLocalConnection(dbPath, "test-org", "test-project", {
        skipFilesystemCheck: true,
      });
      const mode1 = db1.$client.query("PRAGMA journal_mode").get() as {
        journal_mode: string;
      };
      expect(mode1.journal_mode).toBe("wal");
      db1.$client.close();

      // Connection 2: open via createLocalConnection -- WAL persists in the DB file
      const db2 = createLocalConnection(dbPath, "test-org", "test-project", {
        skipFilesystemCheck: true,
      });
      const mode2 = db2.$client.query("PRAGMA journal_mode").get() as {
        journal_mode: string;
      };
      expect(mode2.journal_mode).toBe("wal");
      db2.$client.close();
    },
    { timeout: 15000 },
  );

  it(
    "busy_timeout is re-applied on reconnect (connection-level PRAGMA)",
    () => {
      // Connection 1
      const db1 = createLocalConnection(dbPath, "test-org", "test-project", {
        skipFilesystemCheck: true,
      });
      db1.$client.close();

      // Connection 2: verify busy_timeout is re-applied (not the default 0)
      const db2 = createLocalConnection(dbPath, "test-org", "test-project", {
        skipFilesystemCheck: true,
      });
      // bun:sqlite returns PRAGMA busy_timeout result with key "timeout"
      const timeout = db2.$client.query("PRAGMA busy_timeout").get() as {
        timeout: number;
      };
      expect(timeout.timeout).toBeGreaterThanOrEqual(5000);
      db2.$client.close();
    },
    { timeout: 15000 },
  );

  it(
    "foreign_keys is re-applied on reconnect (connection-level PRAGMA)",
    () => {
      // Connection 1
      const db1 = createLocalConnection(dbPath, "test-org", "test-project", {
        skipFilesystemCheck: true,
      });
      db1.$client.close();

      // Connection 2: verify foreign_keys=ON is re-applied
      const db2 = createLocalConnection(dbPath, "test-org", "test-project", {
        skipFilesystemCheck: true,
      });
      const fk = db2.$client.query("PRAGMA foreign_keys").get() as {
        foreign_keys: number;
      };
      expect(fk.foreign_keys).toBe(1);
      db2.$client.close();
    },
    { timeout: 15000 },
  );

  it(
    "raw Database connection without createLocalConnection does NOT have busy_timeout set",
    () => {
      // First, create the DB with migrations via createLocalConnection
      const db1 = createLocalConnection(dbPath, "test-org", "test-project", {
        skipFilesystemCheck: true,
      });
      db1.$client.close();

      // Open with raw bun:sqlite -- should have default busy_timeout=0
      const rawDb = new Database(dbPath);
      // bun:sqlite returns PRAGMA busy_timeout result with key "timeout"
      const timeout = rawDb.query("PRAGMA busy_timeout").get() as {
        timeout: number;
      };
      // Default is 0 -- confirms busy_timeout is connection-level, not file-level
      expect(timeout.timeout).toBe(0);
      rawDb.close();
    },
    { timeout: 15000 },
  );
});
