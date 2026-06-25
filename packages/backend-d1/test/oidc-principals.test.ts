import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { OidcPrincipalsStore } from "../src/oidc-principals";

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

const BASE = {
  projectId: "proj-1",
  issuer: "https://idp.example.com",
  subject: "workload-123",
  createdBy: "admin-user",
};

describe("OidcPrincipalsStore", () => {
  describe("register + isAllowed", () => {
    it("round-trips the row with its permission", async () => {
      const { store } = createTestStore();
      await store.register({ ...BASE, permission: "write" });

      const row = await store.isAllowed(
        "proj-1",
        "https://idp.example.com",
        "workload-123",
      );
      expect(row).not.toBeNull();
      const r = row as NonNullable<typeof row>;
      expect(r.project_id).toBe("proj-1");
      expect(r.issuer).toBe("https://idp.example.com");
      expect(r.subject).toBe("workload-123");
      expect(r.permission).toBe("write");
      expect(r.enabled).toBe(1);
      expect(r.created_by).toBe("admin-user");
    });

    it("defaults permission to least-privilege 'read'", async () => {
      const { store } = createTestStore();
      await store.register(BASE);
      const row = await store.isAllowed(
        "proj-1",
        "https://idp.example.com",
        "workload-123",
      );
      expect(row?.permission).toBe("read");
    });

    it("returns null for an unknown triple", async () => {
      const { store } = createTestStore();
      await store.register(BASE);
      expect(
        await store.isAllowed("proj-1", "https://idp.example.com", "other"),
      ).toBeNull();
    });

    it("returns null when enabled=0", async () => {
      const { store, sqlite } = createTestStore();
      await store.register(BASE);
      sqlite
        .prepare("UPDATE _oidc_principals SET enabled = 0 WHERE subject = ?")
        .run("workload-123");
      expect(
        await store.isAllowed(
          "proj-1",
          "https://idp.example.com",
          "workload-123",
        ),
      ).toBeNull();
    });

    it("does not match the same subject under a different issuer (isolation)", async () => {
      const { store } = createTestStore();
      await store.register(BASE);
      expect(
        await store.isAllowed(
          "proj-1",
          "https://evil.example.com",
          "workload-123",
        ),
      ).toBeNull();
    });

    it("does not match the same (issuer, subject) under a different project", async () => {
      const { store } = createTestStore();
      await store.register(BASE);
      expect(
        await store.isAllowed(
          "proj-2",
          "https://idp.example.com",
          "workload-123",
        ),
      ).toBeNull();
    });
  });

  describe("register idempotency", () => {
    it("second register() for the same triple silently no-ops", async () => {
      const { store, sqlite } = createTestStore();
      await store.register(BASE);
      await store.register(BASE);
      const count = sqlite
        .prepare(
          "SELECT COUNT(*) as cnt FROM _oidc_principals WHERE subject = ?",
        )
        .get("workload-123") as { cnt: number };
      expect(count.cnt).toBe(1);
    });
  });

  describe("listForProject", () => {
    it("returns only enabled rows for the project", async () => {
      const { store, sqlite } = createTestStore();
      await store.register(BASE);
      await store.register({ ...BASE, subject: "workload-456" });
      sqlite
        .prepare("UPDATE _oidc_principals SET enabled = 0 WHERE subject = ?")
        .run("workload-456");

      const rows = await store.listForProject("proj-1");
      expect(rows).toHaveLength(1);
      expect(rows[0].subject).toBe("workload-123");
    });
  });

  describe("remove", () => {
    it("after remove, isAllowed returns null", async () => {
      const { store } = createTestStore();
      await store.register(BASE);
      await store.remove("proj-1", "https://idp.example.com", "workload-123");
      expect(
        await store.isAllowed(
          "proj-1",
          "https://idp.example.com",
          "workload-123",
        ),
      ).toBeNull();
    });

    it("remove on a non-existent principal does not throw", async () => {
      const { store } = createTestStore();
      await store.remove("proj-1", "https://idp.example.com", "nope");
    });
  });
});
