import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { D1TokenStore } from "../src/token-store";

const CREATE_TOKENS = `
  CREATE TABLE IF NOT EXISTS _tokens (
    token_hash TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    name TEXT NOT NULL,
    note TEXT,
    scopes TEXT NOT NULL DEFAULT 'full',
    created_at INTEGER NOT NULL,
    created_by TEXT NOT NULL,
    last_used_at INTEGER,
    revoked_at INTEGER,
    revoked_by TEXT,
    token_id TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_tokens_project ON _tokens(project_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_tokens_token_id ON _tokens(token_id);
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
  sqlite.exec(CREATE_TOKENS);
  const d1Shim = createD1Shim(sqlite);
  const store = new D1TokenStore(d1Shim as unknown as D1Database);
  return { store, sqlite };
}

describe("D1TokenStore", () => {
  describe("issue + validate lifecycle", () => {
    it("issue() stores a token and validate() retrieves it", async () => {
      const { store } = createTestStore();
      await store.issue({
        tokenHash: "hash-abc",
        projectId: "proj-1",
        name: "my-token",
        createdBy: "user-1",
        createdAt: 1700000000,
      });

      const result = await store.validate("hash-abc");
      expect(result).not.toBeNull();
      const r = result as NonNullable<typeof result>;
      expect(r.projectId).toBe("proj-1");
      expect(r.name).toBe("my-token");
      expect(r.scopes).toBe("full");
      expect(r.tokenId).toBeDefined();
      expect(r.tokenId.length).toBeGreaterThan(0);
    });

    it("validate() returns null for unknown token hash", async () => {
      const { store } = createTestStore();
      const result = await store.validate("nonexistent-hash");
      expect(result).toBeNull();
    });
  });

  describe("revoke", () => {
    it("revoke() returns { revoked: true, tokenHash } and validate() returns null after revocation", async () => {
      const { store } = createTestStore();
      await store.issue({
        tokenHash: "hash-rev",
        projectId: "proj-1",
        name: "revokable",
        createdBy: "user-1",
        createdAt: 1700000000,
      });

      const result = await store.revoke("proj-1", "revokable", "admin-token");
      expect(result.revoked).toBe(true);
      expect(result.tokenHash).toBe("hash-rev");

      const validated = await store.validate("hash-rev");
      expect(validated).toBeNull();
    });

    it("revoke() returns { revoked: false, tokenHash: null } when token is already revoked", async () => {
      const { store } = createTestStore();
      await store.issue({
        tokenHash: "hash-double",
        projectId: "proj-1",
        name: "double-revoke",
        createdBy: "user-1",
        createdAt: 1700000000,
      });

      await store.revoke("proj-1", "double-revoke", "admin-token");
      const secondRevoke = await store.revoke(
        "proj-1",
        "double-revoke",
        "admin-token",
      );
      expect(secondRevoke.revoked).toBe(false);
      expect(secondRevoke.tokenHash).toBeNull();
    });

    it("revoke() stamps revoked_by and list() exposes it", async () => {
      const { store } = createTestStore();
      await store.issue({
        tokenHash: "hash-attr",
        projectId: "proj-1",
        name: "attr-token",
        createdBy: "creator-1",
        createdAt: 1700000000,
      });

      await store.revoke("proj-1", "attr-token", "admin-revoker");
      const list = await store.list("proj-1");
      expect(list).toHaveLength(1);
      expect(list[0].revoked_by).toBe("admin-revoker");
      expect(list[0].revoked_at).not.toBeNull();
    });

    it("active tokens show revoked_by as null in list()", async () => {
      const { store } = createTestStore();
      await store.issue({
        tokenHash: "hash-active",
        projectId: "proj-1",
        name: "active-token",
        createdBy: "creator-1",
        createdAt: 1700000000,
      });

      const list = await store.list("proj-1");
      expect(list[0].revoked_by).toBeNull();
    });

    it("list() shows revoked_by for revoked tokens and null for active", async () => {
      const { store } = createTestStore();
      await store.issue({
        tokenHash: "hash-a",
        projectId: "proj-1",
        name: "token-a",
        createdBy: "user-1",
        createdAt: 1700000001,
      });
      await store.issue({
        tokenHash: "hash-b",
        projectId: "proj-1",
        name: "token-b",
        createdBy: "user-1",
        createdAt: 1700000002,
      });

      await store.revoke("proj-1", "token-a", "revoker-x");

      const list = await store.list("proj-1");
      const revokedItem = list.find((t) => t.name === "token-a");
      const activeItem = list.find((t) => t.name === "token-b");

      expect(revokedItem?.revoked_by).toBe("revoker-x");
      expect(activeItem?.revoked_by).toBeNull();
    });
  });

  describe("updateLastUsedAt", () => {
    it("persists the last_used_at timestamp", async () => {
      const { store, sqlite } = createTestStore();
      await store.issue({
        tokenHash: "hash-used",
        projectId: "proj-1",
        name: "usage-token",
        createdBy: "user-1",
        createdAt: 1700000000,
      });

      await store.updateLastUsedAt("hash-used");

      const row = sqlite
        .prepare("SELECT last_used_at FROM _tokens WHERE token_hash = ?")
        .get("hash-used") as { last_used_at: number | null };
      expect(row.last_used_at).toBeTypeOf("number");
      expect(row.last_used_at).toBeGreaterThan(0);
    });
  });

  describe("list", () => {
    it("returns only tokens for the specified project", async () => {
      const { store } = createTestStore();
      await store.issue({
        tokenHash: "hash-p1",
        projectId: "proj-1",
        name: "token-a",
        createdBy: "user-1",
        createdAt: 1700000001,
      });
      await store.issue({
        tokenHash: "hash-p2",
        projectId: "proj-2",
        name: "token-b",
        createdBy: "user-2",
        createdAt: 1700000002,
      });

      const list = await store.list("proj-1");
      expect(list).toHaveLength(1);
      expect(list[0].name).toBe("token-a");
    });

    it("includes revoked tokens in list results", async () => {
      const { store } = createTestStore();
      await store.issue({
        tokenHash: "hash-listed",
        projectId: "proj-1",
        name: "will-revoke",
        createdBy: "user-1",
        createdAt: 1700000000,
      });

      await store.revoke("proj-1", "will-revoke", "admin-token");
      const list = await store.list("proj-1");
      expect(list).toHaveLength(1);
      expect(list[0].revoked_at).not.toBeNull();
    });

    it("returns tokens in descending created_at order", async () => {
      const { store } = createTestStore();
      await store.issue({
        tokenHash: "hash-old",
        projectId: "proj-1",
        name: "old-token",
        createdBy: "user-1",
        createdAt: 1700000001,
      });
      await store.issue({
        tokenHash: "hash-new",
        projectId: "proj-1",
        name: "new-token",
        createdBy: "user-1",
        createdAt: 1700000099,
      });

      const list = await store.list("proj-1");
      expect(list).toHaveLength(2);
      expect(list[0].name).toBe("new-token");
      expect(list[1].name).toBe("old-token");
    });
  });

  describe("issue with note", () => {
    it("stores and returns the optional note field", async () => {
      const { store } = createTestStore();
      await store.issue({
        tokenHash: "hash-noted",
        projectId: "proj-1",
        name: "noted-token",
        note: "For CI pipeline",
        createdBy: "user-1",
        createdAt: 1700000000,
      });

      const list = await store.list("proj-1");
      expect(list[0].note).toBe("For CI pipeline");
    });
  });

  describe("token_id", () => {
    it("issue() returns a non-empty tokenId", async () => {
      const { store } = createTestStore();
      const result = await store.issue({
        tokenHash: "hash-tid-1",
        projectId: "proj-1",
        name: "test-token",
        createdBy: "user-1",
        createdAt: 1700000000,
      });
      expect(result.tokenId).toBeDefined();
      expect(result.tokenId.length).toBeGreaterThan(0);
    });

    it("validate() returns tokenId matching the issued value", async () => {
      const { store } = createTestStore();
      const { tokenId } = await store.issue({
        tokenHash: "hash-tid-2",
        projectId: "proj-1",
        name: "validate-token",
        createdBy: "user-1",
        createdAt: 1700000000,
      });
      const validated = await store.validate("hash-tid-2");
      expect(validated).not.toBeNull();
      expect(validated?.tokenId).toBe(tokenId);
    });

    it("two tokens with the same name (one revoked) produce different tokenIds", async () => {
      const { store } = createTestStore();
      const { tokenId: id1 } = await store.issue({
        tokenHash: "hash-reuse-1",
        projectId: "proj-1",
        name: "ci-bot",
        createdBy: "user-1",
        createdAt: 1700000000,
      });
      await store.revoke("proj-1", "ci-bot");
      const { tokenId: id2 } = await store.issue({
        tokenHash: "hash-reuse-2",
        projectId: "proj-1",
        name: "ci-bot",
        createdBy: "user-1",
        createdAt: 1700000001,
      });
      expect(id1).not.toBe(id2);
    });

    it("list() includes token_id in each row", async () => {
      const { store } = createTestStore();
      await store.issue({
        tokenHash: "hash-list-1",
        projectId: "proj-1",
        name: "list-token",
        createdBy: "user-1",
        createdAt: 1700000000,
      });
      const rows = await store.list("proj-1");
      expect(rows[0].token_id).toBeDefined();
      expect(rows[0].token_id.length).toBeGreaterThan(0);
    });
  });
});
