import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  NETWORK_FS_TYPES_LINUX,
  findEnclosingMountFsType,
} from "@tila/backend-embedded";
import { afterEach, describe, expect, it } from "vitest";
import {
  LocalDatabaseOpenError,
  LocalFilesystemError,
  createLocalConnection,
} from "../src/connection";

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

    // Verify entities table exists (from the embedded migration set)
    const entities = db.$client
      .query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='entities'",
      )
      .get();
    expect(entities).toBeTruthy();

    // Verify _idempotency table exists (from the embedded idempotency overlay, version 1000)
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

describe("createLocalConnection — corrupt file yields a clean error (R5)", () => {
  let tempDir: string;

  afterEach(() => {
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("wraps a corrupt-DB failure in the CLEAN LocalDatabaseOpenError (not the raw bun:sqlite throw)", () => {
    tempDir = mkdtempSync(join(tmpdir(), "tila-corrupt-"));
    const badPath = join(tempDir, "not-a-db.db");
    // Valid SQLite header magic + garbage body. The failure surfaces when a
    // page-touching PRAGMA/migration runs — which the open+PRAGMA+migration wrap
    // must cover, mirroring the Node connection.
    writeFileSync(
      badPath,
      Buffer.concat([
        Buffer.from("SQLite format 3\0", "utf-8"),
        Buffer.from("garbage-not-a-real-database-file-body"),
      ]),
    );

    let caught: unknown;
    try {
      createLocalConnection(badPath, "test-org", "test-project", {
        skipFilesystemCheck: true,
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(LocalDatabaseOpenError);
    const e = caught as LocalDatabaseOpenError;
    expect(e.message).toContain("Failed to open local SQLite database at");
    expect(e.message).toContain(badPath);
    // The raw native error is preserved as the cause (not swallowed).
    expect(e.cause).toBeInstanceOf(Error);
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

describe("filesystem-guard mount matching (shared with node; C7)", () => {
  // Synthetic /proc/self/mounts: an NFS mount at /mnt/nfs alongside the local
  // ext4 root. The bun and node guards both classify via this same pure helper.
  const mounts = [
    "server:/export /mnt/nfs nfs rw,relatime 0 0",
    "/dev/sda1 / ext4 rw,relatime 0 0",
    "",
  ].join("\n");

  it("does NOT mis-match /mnt/nfsdata against the /mnt/nfs mount (boundary-safe)", () => {
    // The prior naive `dir.startsWith('/mnt/nfs')` bug would classify
    // /mnt/nfsdata as nfs. The boundary-safe matcher must fall through to the
    // ext4 root instead.
    const fsType = findEnclosingMountFsType("/mnt/nfsdata/project", mounts);
    expect(fsType).toBe("ext4");
    expect(NETWORK_FS_TYPES_LINUX.includes(fsType ?? "")).toBe(false);
  });

  it("DOES match a path genuinely under /mnt/nfs", () => {
    const fsType = findEnclosingMountFsType("/mnt/nfs/project", mounts);
    expect(fsType).toBe("nfs");
    expect(NETWORK_FS_TYPES_LINUX.includes(fsType ?? "")).toBe(true);
  });

  it("picks the LONGEST enclosing mount regardless of table order", () => {
    // A nested local mount under an nfs root must win (the dir lives on the
    // nested mount). Order is deliberately parent-before-child.
    const nested = [
      "server:/export /mnt/data nfs rw 0 0",
      "/dev/sdb1 /mnt/data/local ext4 rw 0 0",
      "",
    ].join("\n");
    expect(findEnclosingMountFsType("/mnt/data/local/db", nested)).toBe("ext4");
    expect(findEnclosingMountFsType("/mnt/data/other/db", nested)).toBe("nfs");
  });
});
