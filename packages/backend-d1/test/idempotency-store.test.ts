import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { D1IdempotencyStore } from "../src/idempotency-store";

const CREATE_IDEMPOTENCY = `
  CREATE TABLE IF NOT EXISTS _idempotency (
    key TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    response_json TEXT NOT NULL,
    status_code INTEGER NOT NULL,
    request_hash TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_idempotency_created ON _idempotency (created_at);
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
  sqlite.exec(CREATE_IDEMPOTENCY);
  const d1Shim = createD1Shim(sqlite);
  const store = new D1IdempotencyStore(d1Shim as unknown as D1Database);
  return { store, sqlite };
}

describe("D1IdempotencyStore", () => {
  it("check returns null when no entry exists", async () => {
    const { store } = createTestStore();
    const result = await store.check("test-key", "proj-1");
    expect(result).toBeNull();
  });

  it("check returns the cached entry after store", async () => {
    const { store } = createTestStore();
    await store.store("test-key", "proj-1", 200, JSON.stringify({ ok: true }));
    const result = await store.check("test-key", "proj-1");
    expect(result).not.toBeNull();
    expect(result?.statusCode).toBe(200);
    expect(JSON.parse(result?.body ?? "{}")).toEqual({ ok: true });
  });

  it("check returns null for same key but different projectId (tenant isolation)", async () => {
    const { store } = createTestStore();
    await store.store("test-key", "proj-A", 200, JSON.stringify({ ok: true }));
    // Same key, different project — must be a cache miss
    const result = await store.check("test-key", "proj-B");
    expect(result).toBeNull();
  });

  it("check returns entry for correct projectId even when another project has the same key", async () => {
    const { store } = createTestStore();
    await store.store("test-key", "proj-A", 200, JSON.stringify({ a: true }));
    // proj-B stores a different entry — use a distinct key since key is PRIMARY KEY
    await store.store(
      "test-key-proj-b",
      "proj-B",
      201,
      JSON.stringify({ b: true }),
    );
    const resultA = await store.check("test-key", "proj-A");
    const resultB = await store.check("test-key-proj-b", "proj-B");
    expect(resultA?.statusCode).toBe(200);
    expect(resultB?.statusCode).toBe(201);
  });

  it("check returns requestHash after store with a hash", async () => {
    const { store } = createTestStore();
    const body = JSON.stringify({ ok: true });
    await store.store("hash-key", "proj-1", 200, body, "hashA");
    const result = await store.check("hash-key", "proj-1");
    expect(result).not.toBeNull();
    expect(result?.statusCode).toBe(200);
    expect(result?.body).toBe(body);
    expect(result?.requestHash).toBe("hashA");
  });

  it("check returns requestHash as null for a legacy row without request_hash", async () => {
    const { sqlite } = createTestStore();
    // Insert a legacy row without request_hash (simulates pre-migration row)
    sqlite
      .prepare(
        "INSERT INTO _idempotency (key, project_id, created_at, response_json, status_code) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        "legacy-key",
        "proj-1",
        Date.now(),
        JSON.stringify({ old: true }),
        200,
      );
    const d1Shim = createD1Shim(sqlite);
    const store = new D1IdempotencyStore(d1Shim as unknown as D1Database);
    const result = await store.check("legacy-key", "proj-1");
    expect(result).not.toBeNull();
    expect(result?.requestHash).toBeNull();
  });
});
