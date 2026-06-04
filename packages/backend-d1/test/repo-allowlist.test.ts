import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { RepoAllowlistStore } from "../src/repo-allowlist";

const CREATE_PROJECT_REPOS = `
  CREATE TABLE IF NOT EXISTS _project_repos (
    project_id            TEXT    NOT NULL,
    github_host           TEXT    NOT NULL DEFAULT 'github.com',
    github_owner          TEXT    NOT NULL,
    github_repo           TEXT    NOT NULL,
    github_repo_id        INTEGER NOT NULL,
    min_read_permission   TEXT    NOT NULL DEFAULT 'read',
    min_write_permission  TEXT    NOT NULL DEFAULT 'write',
    enabled               INTEGER NOT NULL DEFAULT 1,
    created_at            INTEGER NOT NULL,
    created_by            TEXT    NOT NULL,
    oidc_permission       TEXT    NOT NULL DEFAULT 'write'
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_project_repos_lookup
    ON _project_repos (project_id, github_host, github_repo_id);
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
  sqlite.exec(CREATE_PROJECT_REPOS);
  const d1Shim = createD1Shim(sqlite);
  const store = new RepoAllowlistStore(d1Shim as unknown as D1Database);
  return { store, sqlite };
}

const BASE_PARAMS = {
  projectId: "proj-1",
  githubHost: "github.com",
  githubOwner: "acme",
  githubRepo: "widgets",
  githubRepoId: 12345,
  createdBy: "admin-user",
};

describe("RepoAllowlistStore", () => {
  describe("register + isRegistered", () => {
    it("register() + isRegistered() round-trip returns the row", async () => {
      const { store } = createTestStore();
      await store.register(BASE_PARAMS);

      const row = await store.isRegistered("proj-1", "github.com", 12345);
      expect(row).not.toBeNull();
      const r = row as NonNullable<typeof row>;
      expect(r.project_id).toBe("proj-1");
      expect(r.github_host).toBe("github.com");
      expect(r.github_owner).toBe("acme");
      expect(r.github_repo).toBe("widgets");
      expect(r.github_repo_id).toBe(12345);
      expect(r.min_read_permission).toBe("write");
      expect(r.min_write_permission).toBe("write");
      expect(r.enabled).toBe(1);
      expect(r.created_by).toBe("admin-user");
    });

    it("isRegistered() returns null for unknown repo", async () => {
      const { store } = createTestStore();
      const row = await store.isRegistered("proj-1", "github.com", 99999);
      expect(row).toBeNull();
    });

    it("isRegistered() returns null when enabled=0", async () => {
      const { store, sqlite } = createTestStore();
      await store.register(BASE_PARAMS);

      // Manually disable the row to simulate soft-disable
      sqlite
        .prepare(
          "UPDATE _project_repos SET enabled = 0 WHERE github_repo_id = ?",
        )
        .run(12345);

      const row = await store.isRegistered("proj-1", "github.com", 12345);
      expect(row).toBeNull();
    });
  });

  describe("register defaults", () => {
    it("defaults min_read_permission to 'write' (contributor-level access)", async () => {
      const { store } = createTestStore();
      await store.register(BASE_PARAMS);

      const row = await store.isRegistered("proj-1", "github.com", 12345);
      expect(row).not.toBeNull();
      expect(row?.min_read_permission).toBe("write");
    });
  });

  describe("register idempotency", () => {
    it("second register() for same repo silently no-ops", async () => {
      const { store, sqlite } = createTestStore();
      await store.register(BASE_PARAMS);
      await store.register(BASE_PARAMS); // should not throw

      const count = sqlite
        .prepare(
          "SELECT COUNT(*) as cnt FROM _project_repos WHERE github_repo_id = ?",
        )
        .get(12345) as { cnt: number };
      expect(count.cnt).toBe(1);
    });
  });

  describe("listForProject", () => {
    it("returns only enabled rows for the project", async () => {
      const { store, sqlite } = createTestStore();
      await store.register(BASE_PARAMS);
      await store.register({
        ...BASE_PARAMS,
        githubOwner: "acme",
        githubRepo: "gadgets",
        githubRepoId: 67890,
      });

      // Disable one row
      sqlite
        .prepare(
          "UPDATE _project_repos SET enabled = 0 WHERE github_repo_id = ?",
        )
        .run(67890);

      const rows = await store.listForProject("proj-1");
      expect(rows).toHaveLength(1);
      expect(rows[0].github_repo_id).toBe(12345);
    });

    it("excludes rows for other projects", async () => {
      const { store } = createTestStore();
      await store.register(BASE_PARAMS);
      await store.register({
        ...BASE_PARAMS,
        projectId: "proj-2",
        githubRepoId: 67890,
      });

      const rows = await store.listForProject("proj-1");
      expect(rows).toHaveLength(1);
      expect(rows[0].project_id).toBe("proj-1");
    });
  });

  describe("remove", () => {
    it("after remove, isRegistered returns null", async () => {
      const { store } = createTestStore();
      await store.register(BASE_PARAMS);

      await store.remove("proj-1", "github.com", 12345);

      const row = await store.isRegistered("proj-1", "github.com", 12345);
      expect(row).toBeNull();
    });

    it("remove on non-existent repo does not throw", async () => {
      const { store } = createTestStore();
      // Should not throw
      await store.remove("proj-1", "github.com", 99999);
    });
  });
});
