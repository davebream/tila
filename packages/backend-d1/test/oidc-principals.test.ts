import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { OidcPrincipalsStore } from "../src/oidc-principals";

// DDL mirrors migration 0021_oidc_principals.sql exactly.
const CREATE_OIDC_PRINCIPALS = `
  CREATE TABLE IF NOT EXISTS _oidc_principals (
    project_id  TEXT    NOT NULL,
    issuer      TEXT    NOT NULL,
    subject     TEXT    NOT NULL,
    permission  TEXT    NOT NULL DEFAULT 'read',
    enabled     INTEGER NOT NULL DEFAULT 1,
    created_at  INTEGER NOT NULL,
    created_by  TEXT    NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_oidc_principals_lookup
    ON _oidc_principals (project_id, issuer, subject);
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
  sqlite.exec(CREATE_OIDC_PRINCIPALS);
  const d1Shim = createD1Shim(sqlite);
  const store = new OidcPrincipalsStore(d1Shim as unknown as D1Database);
  return { store, sqlite };
}

const BASE_PARAMS = {
  projectId: "proj-1",
  issuer: "https://token.actions.githubusercontent.com",
  subject: "repo:acme/widgets:ref:refs/heads/main",
  permission: "write" as const,
  createdBy: "admin-user",
};

describe("OidcPrincipalsStore", () => {
  describe("register + isAllowed", () => {
    it("(a) register() then isAllowed() returns the row with its permission", async () => {
      const { store } = createTestStore();
      await store.register(BASE_PARAMS);

      const row = await store.isAllowed(
        "proj-1",
        "https://token.actions.githubusercontent.com",
        "repo:acme/widgets:ref:refs/heads/main",
      );
      expect(row).not.toBeNull();
      // biome prefers optional chaining; use type assertion via if-guard instead
      if (!row) throw new Error("row should not be null");
      expect(row.project_id).toBe("proj-1");
      expect(row.issuer).toBe("https://token.actions.githubusercontent.com");
      expect(row.subject).toBe("repo:acme/widgets:ref:refs/heads/main");
      expect(row.permission).toBe("write");
      expect(row.enabled).toBe(1);
      expect(row.created_by).toBe("admin-user");
      expect(typeof row.created_at).toBe("number");
    });

    it("(b) isAllowed() returns null for an unknown triple", async () => {
      const { store } = createTestStore();
      const row = await store.isAllowed(
        "proj-1",
        "https://token.actions.githubusercontent.com",
        "repo:acme/unknown",
      );
      expect(row).toBeNull();
    });

    it("(c) isAllowed() returns null when enabled=0", async () => {
      const { store, sqlite } = createTestStore();
      await store.register(BASE_PARAMS);

      sqlite
        .prepare(
          "UPDATE _oidc_principals SET enabled = 0 WHERE project_id = ? AND issuer = ? AND subject = ?",
        )
        .run(
          "proj-1",
          "https://token.actions.githubusercontent.com",
          "repo:acme/widgets:ref:refs/heads/main",
        );

      const row = await store.isAllowed(
        "proj-1",
        "https://token.actions.githubusercontent.com",
        "repo:acme/widgets:ref:refs/heads/main",
      );
      expect(row).toBeNull();
    });

    it("(d) isAllowed() does not match same subject under a different issuer", async () => {
      const { store } = createTestStore();
      await store.register(BASE_PARAMS);

      const row = await store.isAllowed(
        "proj-1",
        "https://other-idp.example.com",
        "repo:acme/widgets:ref:refs/heads/main",
      );
      expect(row).toBeNull();
    });

    it("(d) isAllowed() does not match same issuer+subject under a different project_id", async () => {
      const { store } = createTestStore();
      await store.register(BASE_PARAMS);

      const row = await store.isAllowed(
        "proj-other",
        "https://token.actions.githubusercontent.com",
        "repo:acme/widgets:ref:refs/heads/main",
      );
      expect(row).toBeNull();
    });
  });

  describe("register defaults", () => {
    it("register() defaults permission to 'read' when not specified", async () => {
      const { store } = createTestStore();
      await store.register({
        projectId: "proj-1",
        issuer: "https://idp.example.com",
        subject: "some-subject",
        createdBy: "admin",
      });

      const row = await store.isAllowed(
        "proj-1",
        "https://idp.example.com",
        "some-subject",
      );
      expect(row).not.toBeNull();
      if (!row) throw new Error("row should not be null");
      expect(row.permission).toBe("read");
    });
  });

  describe("register idempotency", () => {
    it("(e) duplicate register() is idempotent (onConflictDoNothing)", async () => {
      const { store, sqlite } = createTestStore();
      await store.register(BASE_PARAMS);
      await store.register(BASE_PARAMS); // should not throw

      const count = sqlite
        .prepare(
          "SELECT COUNT(*) as cnt FROM _oidc_principals WHERE project_id = ? AND issuer = ? AND subject = ?",
        )
        .get(
          "proj-1",
          "https://token.actions.githubusercontent.com",
          "repo:acme/widgets:ref:refs/heads/main",
        ) as { cnt: number };
      expect(count.cnt).toBe(1);
    });
  });

  describe("listForProject", () => {
    it("(f) returns only enabled rows for the given project", async () => {
      const { store, sqlite } = createTestStore();
      await store.register(BASE_PARAMS);
      await store.register({
        ...BASE_PARAMS,
        subject: "repo:acme/other:ref:refs/heads/main",
      });

      // Disable one row
      sqlite
        .prepare("UPDATE _oidc_principals SET enabled = 0 WHERE subject = ?")
        .run("repo:acme/other:ref:refs/heads/main");

      const rows = await store.listForProject("proj-1");
      expect(rows).toHaveLength(1);
      expect(rows[0].subject).toBe("repo:acme/widgets:ref:refs/heads/main");
    });

    it("(f) listForProject() excludes rows for other projects", async () => {
      const { store } = createTestStore();
      await store.register(BASE_PARAMS);
      await store.register({
        ...BASE_PARAMS,
        projectId: "proj-2",
        subject: "some-other-subject",
      });

      const rows = await store.listForProject("proj-1");
      expect(rows).toHaveLength(1);
      expect(rows[0].project_id).toBe("proj-1");
    });
  });

  describe("remove", () => {
    it("(g) after remove(), isAllowed returns null", async () => {
      const { store } = createTestStore();
      await store.register(BASE_PARAMS);

      await store.remove(
        "proj-1",
        "https://token.actions.githubusercontent.com",
        "repo:acme/widgets:ref:refs/heads/main",
      );

      const row = await store.isAllowed(
        "proj-1",
        "https://token.actions.githubusercontent.com",
        "repo:acme/widgets:ref:refs/heads/main",
      );
      expect(row).toBeNull();
    });

    it("(g) remove() on non-existent triple does not throw", async () => {
      const { store } = createTestStore();
      await store.remove(
        "proj-1",
        "https://idp.example.com",
        "unknown-subject",
      );
    });
  });
});
