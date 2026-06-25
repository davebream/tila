import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { AdminGrantsStore } from "../src/admin-grants";

const CREATE_ADMIN_GRANTS = `
  CREATE TABLE IF NOT EXISTS _admin_grants (
    project_id            TEXT    NOT NULL,
    github_host           TEXT    NOT NULL DEFAULT 'github.com',
    github_user_id        INTEGER NOT NULL,
    github_login_snapshot TEXT,
    granted_by_user_id    INTEGER,
    granted_at            INTEGER NOT NULL,
    revoked_at            INTEGER,
    revoked_by_user_id    INTEGER,
    identity_host         TEXT    NOT NULL DEFAULT 'github.com',
    subject_id            TEXT    NOT NULL DEFAULT ''
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_grants_active_subject
    ON _admin_grants (project_id, identity_host, subject_id)
    WHERE revoked_at IS NULL;
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
  sqlite.exec(CREATE_ADMIN_GRANTS);
  const d1Shim = createD1Shim(sqlite);
  const store = new AdminGrantsStore(d1Shim as unknown as D1Database);
  return { store, sqlite };
}

const BASE_PARAMS = {
  projectId: "proj-1",
  githubHost: "github.com",
  githubUserId: 42,
  githubLoginSnapshot: "alice",
  grantedByUserId: 99,
};

describe("AdminGrantsStore", () => {
  describe("grant + isActiveAdmin round-trip", () => {
    it("returns true and all columns are persisted correctly", async () => {
      const { store, sqlite } = createTestStore();
      await store.grant(BASE_PARAMS);

      const isAdmin = await store.isActiveAdmin("proj-1", "github.com", 42);
      expect(isAdmin).toBe(true);

      const row = sqlite
        .prepare(
          "SELECT * FROM _admin_grants WHERE project_id = ? AND github_user_id = ?",
        )
        .get("proj-1", 42) as Record<string, unknown>;

      expect(row.project_id).toBe("proj-1");
      expect(row.github_host).toBe("github.com");
      expect(row.github_user_id).toBe(42);
      expect(row.github_login_snapshot).toBe("alice");
      expect(row.granted_by_user_id).toBe(99);
      expect(typeof row.granted_at).toBe("number");
      expect(row.granted_at as number).toBeGreaterThan(0);
      expect(row.revoked_at).toBeNull();
      expect(row.revoked_by_user_id).toBeNull();
    });
  });

  describe("idempotent re-grant", () => {
    it("second grant for same identity creates exactly one active row and neither call throws", async () => {
      const { store, sqlite } = createTestStore();
      await store.grant(BASE_PARAMS);
      await expect(store.grant(BASE_PARAMS)).resolves.toBeUndefined();

      const count = sqlite
        .prepare(
          "SELECT COUNT(*) as cnt FROM _admin_grants WHERE project_id = ? AND github_user_id = ? AND revoked_at IS NULL",
        )
        .get("proj-1", 42) as { cnt: number };
      expect(count.cnt).toBe(1);
    });
  });

  describe("revoke", () => {
    it("sets revoked_at so isActiveAdmin returns false, row physically persists", async () => {
      const { store, sqlite } = createTestStore();
      await store.grant(BASE_PARAMS);

      await store.revoke("proj-1", "github.com", 42, 100);

      const isAdmin = await store.isActiveAdmin("proj-1", "github.com", 42);
      expect(isAdmin).toBe(false);

      const row = sqlite
        .prepare(
          "SELECT * FROM _admin_grants WHERE project_id = ? AND github_user_id = ?",
        )
        .get("proj-1", 42) as Record<string, unknown>;
      expect(row).not.toBeNull();
      expect(typeof row.revoked_at).toBe("number");
      expect(row.revoked_at as number).toBeGreaterThan(0);
    });
  });

  describe("list", () => {
    it("excludes revoked rows and is project-scoped", async () => {
      const { store, sqlite } = createTestStore();
      // Two active grants for proj-1
      await store.grant({ ...BASE_PARAMS, githubUserId: 42 });
      await store.grant({
        ...BASE_PARAMS,
        githubUserId: 43,
        githubLoginSnapshot: "bob",
      });
      // One grant for proj-2 that should NOT appear
      await store.grant({
        ...BASE_PARAMS,
        projectId: "proj-2",
        githubUserId: 44,
      });
      // Revoke one of proj-1's grants
      await store.revoke("proj-1", "github.com", 43);

      const rows = await store.list("proj-1");
      expect(rows).toHaveLength(1);
      expect(rows[0].github_user_id).toBe(42);
      expect(rows[0].project_id).toBe("proj-1");
      expect(rows[0].revoked_at).toBeNull();

      // Explicitly verify proj-2 row not included
      const allRows = sqlite
        .prepare("SELECT COUNT(*) as cnt FROM _admin_grants")
        .get() as { cnt: number };
      expect(allRows.cnt).toBe(3); // all 3 physical rows exist
    });
  });

  describe("re-grant after revoke", () => {
    it("isActiveAdmin returns true, exactly one active row, two physical rows", async () => {
      const { store, sqlite } = createTestStore();
      await store.grant(BASE_PARAMS);
      await store.revoke("proj-1", "github.com", 42);
      await store.grant(BASE_PARAMS);

      const isAdmin = await store.isActiveAdmin("proj-1", "github.com", 42);
      expect(isAdmin).toBe(true);

      const activeCount = sqlite
        .prepare(
          "SELECT COUNT(*) as cnt FROM _admin_grants WHERE project_id = ? AND github_user_id = ? AND revoked_at IS NULL",
        )
        .get("proj-1", 42) as { cnt: number };
      expect(activeCount.cnt).toBe(1);

      const totalCount = sqlite
        .prepare(
          "SELECT COUNT(*) as cnt FROM _admin_grants WHERE project_id = ? AND github_user_id = ?",
        )
        .get("proj-1", 42) as { cnt: number };
      expect(totalCount.cnt).toBe(2);
    });
  });

  describe("revoke on non-admin", () => {
    it("is a no-op; row count is unchanged", async () => {
      const { store, sqlite } = createTestStore();
      await store.grant(BASE_PARAMS);

      const before = sqlite
        .prepare("SELECT COUNT(*) as cnt FROM _admin_grants")
        .get() as { cnt: number };

      await store.revoke("proj-1", "github.com", 9999); // unknown user

      const after = sqlite
        .prepare("SELECT COUNT(*) as cnt FROM _admin_grants")
        .get() as { cnt: number };

      expect(after.cnt).toBe(before.cnt);
    });
  });
});
