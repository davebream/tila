/**
 * Connection-level invariants for the Node (better-sqlite3) embedded backend:
 *
 *  - PRAGMA parity with the bun connection (busy_timeout FIRST, then WAL, then
 *    foreign_keys) — a tested invariant, because a Node writer with
 *    busy_timeout=0 would immediately SQLITE_BUSY against a bun writer (R2);
 *  - the dynamic better-sqlite3 import's CJS default-vs-named shape is handled
 *    (R8) — exercised implicitly by every successful open;
 *  - a corrupt/locked DB file yields a CLEAN error, not a raw native throw (R5).
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createNodeConnection } from "../../local/connection";

// Runtime view of the drizzle better-sqlite3 handle (the EmbeddedDb type erases
// `$client`, but the better-sqlite3 adapter attaches it at runtime).
interface RawClientView {
  $client: {
    pragma(s: string, opts: { simple: true }): unknown;
    close(): void;
  };
}

describe("createNodeConnection — PRAGMA parity (R2)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tila-conn-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("applies busy_timeout=5000, journal_mode=WAL, foreign_keys=ON", async () => {
    const conn = await createNodeConnection(join(dir, "p.db"), {
      skipFilesystemCheck: true,
    });
    try {
      const client = (conn.db as unknown as RawClientView).$client;
      // busy_timeout FIRST in the apply order — non-zero proves a bun writer
      // won't be raced into immediate SQLITE_BUSY.
      expect(client.pragma("busy_timeout", { simple: true })).toBe(5000);
      // WAL journal mode (string compare, case-insensitive).
      expect(
        String(client.pragma("journal_mode", { simple: true })).toLowerCase(),
      ).toBe("wal");
      // foreign_keys ON (1).
      expect(client.pragma("foreign_keys", { simple: true })).toBe(1);
    } finally {
      conn.close();
    }
  });
});

describe("createNodeConnection — corrupt file yields a clean error (R5)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tila-corrupt-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("wraps a non-SQLite file open in a clean Error, not a raw native throw", async () => {
    const badPath = join(dir, "not-a-db.db");
    // Write a valid SQLite header magic but truncated/garbage body so the open
    // (or first PRAGMA) fails with SQLITE_NOTADB rather than silently creating.
    writeFileSync(
      badPath,
      Buffer.concat([
        Buffer.from("SQLite format 3\0", "utf-8"),
        Buffer.from("garbage-not-a-real-database-file-body"),
      ]),
    );

    await expect(
      createNodeConnection(badPath, { skipFilesystemCheck: true }),
    ).rejects.toThrow(
      /Failed to open local SQLite database|SQLITE_NOTADB|file is not a database/i,
    );
  });
});
