import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import {
  D1DeploymentMetaStore,
  DeploymentIdUnavailable,
} from "../src/deployment-meta";

// Migration SQL — must match 0017_deployment_meta.sql exactly (including the
// CHECK (id = 1) singleton guard the tests assert against).
const CREATE_DEPLOYMENT_META = `
  CREATE TABLE IF NOT EXISTS _deployment_meta (
    id          INTEGER PRIMARY KEY CHECK (id = 1),
    instance_id TEXT    NOT NULL,
    created_at  INTEGER NOT NULL
  );
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
  sqlite.exec(CREATE_DEPLOYMENT_META);
  const d1Shim = createD1Shim(sqlite);
  const store = new D1DeploymentMetaStore(d1Shim as unknown as D1Database);
  return { store, sqlite, d1Shim };
}

describe("D1DeploymentMetaStore", () => {
  describe("get()", () => {
    it("returns null on empty table", async () => {
      const { store } = createTestStore();
      const result = await store.get();
      expect(result).toBeNull();
    });

    it("returns the instance_id after seeding", async () => {
      const { store } = createTestStore();
      await store.seed("test-instance-id");
      const result = await store.get();
      expect(result).toBe("test-instance-id");
    });
  });

  describe("seed()", () => {
    it("inserts a specific id and get() returns it", async () => {
      const { store } = createTestStore();
      await store.seed("my-fixed-id");
      const result = await store.get();
      expect(result).toBe("my-fixed-id");
    });

    it("seed(x) then seed(y) leaves the id as x (ON CONFLICT DO NOTHING)", async () => {
      const { store } = createTestStore();
      await store.seed("first-id");
      await store.seed("second-id");
      const result = await store.get();
      expect(result).toBe("first-id");
    });
  });

  describe("ensure()", () => {
    it("returns a UUID and persists it when table is empty", async () => {
      const { store } = createTestStore();
      const id = await store.ensure();
      // Should look like a UUID
      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
      // Should be persisted
      const persisted = await store.get();
      expect(persisted).toBe(id);
    });

    it("returns the existing id when table already has a row (idempotent)", async () => {
      const { store } = createTestStore();
      await store.seed("existing-id");
      const id = await store.ensure();
      expect(id).toBe("existing-id");
      // Still only one row
      const persisted = await store.get();
      expect(persisted).toBe("existing-id");
    });

    it("concurrent calls converge on the same id (ON CONFLICT DO NOTHING design guarantee)", async () => {
      const { store } = createTestStore();
      // In the test harness the D1 shim is synchronous under the hood (better-sqlite3),
      // so a true race is not observable. However, the design guarantees convergence via
      // INSERT … ON CONFLICT(id) DO NOTHING + post-insert SELECT — both callers will
      // resolve to whichever row won the INSERT race. We assert both sides of the
      // Promise.all return the SAME string.
      const [id1, id2] = await Promise.all([store.ensure(), store.ensure()]);
      expect(id1).toBe(id2);
      expect(id1).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
    });
  });

  describe("singleton guard", () => {
    it("CHECK (id = 1) rejects a raw INSERT with id = 2", async () => {
      const { sqlite } = createTestStore();
      expect(() => {
        sqlite.exec(
          "INSERT INTO _deployment_meta (id, instance_id, created_at) VALUES (2, 'bad', 0)",
        );
      }).toThrow();
    });
  });

  describe("DeploymentIdUnavailable", () => {
    it("is exported and is an Error subclass", () => {
      const err = new DeploymentIdUnavailable("test");
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toBe("test");
    });
  });
});
