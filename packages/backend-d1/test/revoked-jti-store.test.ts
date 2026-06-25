import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { D1RevokedJtiStore } from "../src/revoked-jti-store";

const CREATE_REVOKED_JTI = `
  CREATE TABLE IF NOT EXISTS _revoked_jti (
    jti        TEXT    PRIMARY KEY,
    project_id TEXT    NOT NULL,
    revoked_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_revoked_jti_project ON _revoked_jti (project_id);
`;

function createD1Shim(sqlite: Database.Database) {
  return {
    prepare(query: string) {
      return {
        bind(...params: unknown[]) {
          return {
            async all() {
              const stmt = sqlite.prepare(query);
              const rows = stmt.all(...(params as unknown[]));
              return { results: rows, success: true };
            },
            async first() {
              const stmt = sqlite.prepare(query);
              const row = stmt.get(...(params as unknown[]));
              return row ?? null;
            },
            async run() {
              const stmt = sqlite.prepare(query);
              const info = stmt.run(...(params as unknown[]));
              return { success: true, meta: { changes: info.changes } };
            },
            async raw() {
              const stmt = sqlite.prepare(query);
              stmt.raw(true);
              const rows = stmt.all(...(params as unknown[]));
              return rows;
            },
          };
        },
      };
    },
    async batch(stmts: unknown[]) {
      return stmts.map((s: unknown) => (s as { all: () => unknown }).all());
    },
    async exec(query: string) {
      sqlite.exec(query);
      return { count: 1, duration: 0 };
    },
  };
}

function createTestStore() {
  const sqlite = new Database(":memory:");
  sqlite.exec(CREATE_REVOKED_JTI);
  const d1Shim = createD1Shim(sqlite);
  const store = new D1RevokedJtiStore(d1Shim as unknown as D1Database);
  return { store, sqlite };
}

function seedRow(sqlite: Database.Database, jti: string, revokedAt: number) {
  sqlite
    .prepare(
      "INSERT INTO _revoked_jti (jti, project_id, revoked_at) VALUES (?, ?, ?)",
    )
    .run(jti, "proj-1", revokedAt);
}

describe("D1RevokedJtiStore.deleteExpired", () => {
  it("deletes a row strictly older than the cutoff", async () => {
    const { store, sqlite } = createTestStore();
    const cutoff = 1_700_000_000_000;
    seedRow(sqlite, "old", cutoff - 1);

    const deleted = await store.deleteExpired(cutoff);

    expect(deleted).toBe(1);
    expect(await store.isRevoked("old")).toBe(false);
  });

  it("keeps a row exactly at the cutoff (strict <)", async () => {
    const { store, sqlite } = createTestStore();
    const cutoff = 1_700_000_000_000;
    seedRow(sqlite, "boundary", cutoff);

    const deleted = await store.deleteExpired(cutoff);

    expect(deleted).toBe(0);
    expect(await store.isRevoked("boundary")).toBe(true);
  });

  it("keeps a row newer than the cutoff", async () => {
    const { store, sqlite } = createTestStore();
    const cutoff = 1_700_000_000_000;
    seedRow(sqlite, "fresh", cutoff + 1);

    const deleted = await store.deleteExpired(cutoff);

    expect(deleted).toBe(0);
    expect(await store.isRevoked("fresh")).toBe(true);
  });

  it("returns the count of deleted rows", async () => {
    const { store, sqlite } = createTestStore();
    const cutoff = 1_700_000_000_000;
    seedRow(sqlite, "old-1", cutoff - 100);
    seedRow(sqlite, "old-2", cutoff - 50);
    seedRow(sqlite, "boundary", cutoff);
    seedRow(sqlite, "fresh", cutoff + 100);

    const deleted = await store.deleteExpired(cutoff);

    expect(deleted).toBe(2);
    expect(await store.isRevoked("old-1")).toBe(false);
    expect(await store.isRevoked("old-2")).toBe(false);
    expect(await store.isRevoked("boundary")).toBe(true);
    expect(await store.isRevoked("fresh")).toBe(true);
  });

  it("returns 0 when no rows match", async () => {
    const { store, sqlite } = createTestStore();
    const cutoff = 1_700_000_000_000;
    seedRow(sqlite, "fresh", cutoff + 1);

    const deleted = await store.deleteExpired(cutoff);

    expect(deleted).toBe(0);
  });
});
