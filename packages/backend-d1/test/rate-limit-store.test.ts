import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { D1RateLimitStore } from "../src/rate-limit-store";

const CREATE_RATE_LIMITS = `
  CREATE TABLE IF NOT EXISTS _rate_limits (
    ip TEXT PRIMARY KEY,
    count INTEGER NOT NULL,
    window_start INTEGER NOT NULL
  );
`;

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec(CREATE_RATE_LIMITS);
  return sqlite;
}

/**
 * Minimal D1Database shim for better-sqlite3.
 * Implements prepare().bind().all/first/run chain that Drizzle uses.
 */
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

describe("D1RateLimitStore", () => {
  let sqlite: Database.Database;
  let store: D1RateLimitStore;

  beforeEach(() => {
    vi.useFakeTimers();
    sqlite = createTestDb();
    const d1 = createD1Shim(sqlite) as unknown as D1Database;
    store = new D1RateLimitStore(d1);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("check", () => {
    it("returns false when no failures recorded for IP", async () => {
      const result = await store.check("1.2.3.4", 20, 60_000);
      expect(result).toBe(false);
    });

    it("returns false when failures are below threshold", async () => {
      for (let i = 0; i < 19; i++) {
        await store.recordFailure("1.2.3.4", 60_000);
      }
      const result = await store.check("1.2.3.4", 20, 60_000);
      expect(result).toBe(false);
    });

    it("returns true when failures reach threshold", async () => {
      for (let i = 0; i < 20; i++) {
        await store.recordFailure("1.2.3.4", 60_000);
      }
      const result = await store.check("1.2.3.4", 20, 60_000);
      expect(result).toBe(true);
    });

    it("returns false after window expires", async () => {
      for (let i = 0; i < 20; i++) {
        await store.recordFailure("1.2.3.4", 60_000);
      }
      vi.advanceTimersByTime(60_001);
      const result = await store.check("1.2.3.4", 20, 60_000);
      expect(result).toBe(false);
    });
  });

  describe("recordFailure", () => {
    it("creates a new row on first failure", async () => {
      await store.recordFailure("5.6.7.8", 60_000);
      const row = sqlite
        .prepare("SELECT * FROM _rate_limits WHERE ip = ?")
        .get("5.6.7.8") as { count: number };
      expect(row.count).toBe(1);
    });

    it("increments count on subsequent failures within window", async () => {
      await store.recordFailure("5.6.7.8", 60_000);
      await store.recordFailure("5.6.7.8", 60_000);
      await store.recordFailure("5.6.7.8", 60_000);
      const row = sqlite
        .prepare("SELECT * FROM _rate_limits WHERE ip = ?")
        .get("5.6.7.8") as { count: number };
      expect(row.count).toBe(3);
    });

    it("resets count when window has expired", async () => {
      await store.recordFailure("5.6.7.8", 60_000);
      await store.recordFailure("5.6.7.8", 60_000);
      vi.advanceTimersByTime(60_001);
      await store.recordFailure("5.6.7.8", 60_000);
      const row = sqlite
        .prepare("SELECT * FROM _rate_limits WHERE ip = ?")
        .get("5.6.7.8") as { count: number };
      expect(row.count).toBe(1);
    });
  });
});
