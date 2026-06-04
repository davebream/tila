import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalFilesystemError, createLocalConnection } from "../src/connection";

describe("createLocalConnection", () => {
  let tempDir: string;

  afterEach(() => {
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  function makeTempDb(): string {
    tempDir = mkdtempSync(join(tmpdir(), "tila-test-"));
    return join(tempDir, "test.db");
  }

  it("opens a database and returns a Drizzle instance", () => {
    const dbPath = makeTempDb();
    const db = createLocalConnection(dbPath, "test-org", "test-project", {
      skipFilesystemCheck: true,
    });
    expect(db).toBeDefined();
    expect(db.$client).toBeInstanceOf(Database);
    db.$client.close();
  });

  it("sets WAL journal mode", () => {
    const dbPath = makeTempDb();
    const db = createLocalConnection(dbPath, "test-org", "test-project", {
      skipFilesystemCheck: true,
    });
    const result = db.$client.query("PRAGMA journal_mode").get() as {
      journal_mode: string;
    };
    expect(result.journal_mode).toBe("wal");
    db.$client.close();
  });

  it("sets busy_timeout to 5000", () => {
    const dbPath = makeTempDb();
    const db = createLocalConnection(dbPath, "test-org", "test-project", {
      skipFilesystemCheck: true,
    });
    // bun:sqlite returns the value as { timeout: N } (not busy_timeout)
    const result = db.$client.query("PRAGMA busy_timeout").get() as
      | { timeout: number }
      | { busy_timeout: number };
    const value =
      "timeout" in result
        ? result.timeout
        : (result as { busy_timeout: number }).busy_timeout;
    expect(value).toBe(5000);
    db.$client.close();
  });

  it("enables foreign keys", () => {
    const dbPath = makeTempDb();
    const db = createLocalConnection(dbPath, "test-org", "test-project", {
      skipFilesystemCheck: true,
    });
    const result = db.$client.query("PRAGMA foreign_keys").get() as {
      foreign_keys: number;
    };
    expect(result.foreign_keys).toBe(1);
    db.$client.close();
  });

  it("runs all migrations (shared + local)", () => {
    const dbPath = makeTempDb();
    const db = createLocalConnection(dbPath, "test-org", "test-project", {
      skipFilesystemCheck: true,
    });

    // Verify entities table exists (from shared MIGRATION_0001)
    const entities = db.$client
      .query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='entities'",
      )
      .get();
    expect(entities).toBeTruthy();

    // Verify _idempotency table exists (from local MIGRATION_0005)
    const idempotency = db.$client
      .query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='_idempotency'",
      )
      .get();
    expect(idempotency).toBeTruthy();

    // Verify _migrations table tracks all versions
    const migrations = db.$client
      .query("SELECT version FROM _migrations ORDER BY version")
      .all() as { version: number }[];
    const versions = migrations.map((m) => m.version);
    expect(versions).toContain(1);
    expect(versions).toContain(5);

    db.$client.close();
  });

  it("runs migrations idempotently on re-open", () => {
    const dbPath = makeTempDb();

    // First open
    const db1 = createLocalConnection(dbPath, "test-org", "test-project", {
      skipFilesystemCheck: true,
    });
    db1.$client.close();

    // Second open -- should not throw
    const db2 = createLocalConnection(dbPath, "test-org", "test-project", {
      skipFilesystemCheck: true,
    });
    const migrations = db2.$client
      .query("SELECT version FROM _migrations ORDER BY version")
      .all() as { version: number }[];
    expect(migrations.length).toBeGreaterThanOrEqual(2);
    db2.$client.close();
  });
});

describe("LocalFilesystemError", () => {
  it("is an exported error class", () => {
    const err = new LocalFilesystemError("test message");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("LocalFilesystemError");
    expect(err.message).toBe("test message");
  });
});
