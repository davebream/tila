import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { D1SessionStore } from "../src/session-store";

const CREATE_SESSIONS = `
  CREATE TABLE IF NOT EXISTS _sessions (
    session_hash TEXT PRIMARY KEY,
    project_id   TEXT NOT NULL,
    token_hash   TEXT NOT NULL,
    actor_name   TEXT NOT NULL,
    scopes       TEXT NOT NULL DEFAULT 'full',
    permission   TEXT NOT NULL DEFAULT 'read',
    created_at   INTEGER NOT NULL,
    expires_at   INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_expires ON _sessions (expires_at);
`;

/** Pre-migration schema — no permission column. Used by the backfill test. */
const CREATE_SESSIONS_PRE_MIGRATION = `
  CREATE TABLE IF NOT EXISTS _sessions (
    session_hash TEXT PRIMARY KEY,
    project_id   TEXT NOT NULL,
    token_hash   TEXT NOT NULL,
    actor_name   TEXT NOT NULL,
    scopes       TEXT NOT NULL DEFAULT 'full',
    created_at   INTEGER NOT NULL,
    expires_at   INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_expires ON _sessions (expires_at);
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
  sqlite.exec(CREATE_SESSIONS);
  const d1Shim = createD1Shim(sqlite);
  const store = new D1SessionStore(d1Shim as unknown as D1Database);
  return { store, sqlite };
}

describe("D1SessionStore", () => {
  it("create + validate round-trip returns SessionResult", async () => {
    const { store } = createTestStore();
    const now = Date.now();
    await store.create({
      sessionHash: "hash123",
      projectId: "proj-1",
      tokenHash: "tokenhash456",
      actorName: "test-actor",
      scopes: "full",
      permission: "read",
      expiresAt: now + 3_600_000,
    });

    const result = await store.validate("hash123");
    expect(result).not.toBeNull();
    expect(result?.projectId).toBe("proj-1");
    expect(result?.tokenHash).toBe("tokenhash456");
    expect(result?.name).toBe("test-actor");
    expect(result?.scopes).toBe("full");
    expect(result?.permission).toBe("read");
    expect(result?.expiresAt).toBeGreaterThan(now);
  });

  it("validate returns null for expired session", async () => {
    const { store } = createTestStore();
    await store.create({
      sessionHash: "expired-hash",
      projectId: "proj-1",
      tokenHash: "tokenhash456",
      actorName: "test-actor",
      scopes: "full",
      permission: "read",
      expiresAt: Date.now() - 1_000, // already expired
    });

    const result = await store.validate("expired-hash");
    expect(result).toBeNull();
  });

  it("validate returns null for non-existent session", async () => {
    const { store } = createTestStore();
    const result = await store.validate("nonexistent");
    expect(result).toBeNull();
  });

  it("revoke + validate returns null", async () => {
    const { store } = createTestStore();
    await store.create({
      sessionHash: "revoke-me",
      projectId: "proj-1",
      tokenHash: "tokenhash456",
      actorName: "test-actor",
      scopes: "full",
      permission: "read",
      expiresAt: Date.now() + 3_600_000,
    });

    await store.revoke("revoke-me");
    const result = await store.validate("revoke-me");
    expect(result).toBeNull();
  });

  it("deleteExpired removes only expired rows", async () => {
    const { store } = createTestStore();
    const now = Date.now();
    await store.create({
      sessionHash: "valid-session",
      projectId: "proj-1",
      tokenHash: "tok1",
      actorName: "actor1",
      scopes: "full",
      permission: "read",
      expiresAt: now + 3_600_000,
    });
    await store.create({
      sessionHash: "expired-session",
      projectId: "proj-1",
      tokenHash: "tok2",
      actorName: "actor2",
      scopes: "full",
      permission: "read",
      expiresAt: now - 1_000,
    });

    const { deleted } = await store.deleteExpired();
    expect(deleted).toBe(1);

    const valid = await store.validate("valid-session");
    expect(valid).not.toBeNull();
  });

  it("create persists permission and validate returns it", async () => {
    const { store } = createTestStore();
    const now = Date.now();

    await store.create({
      sessionHash: "admin-session",
      projectId: "proj-1",
      tokenHash: "tok-admin",
      actorName: "admin-actor",
      scopes: "full",
      permission: "admin",
      expiresAt: now + 3_600_000,
    });

    const result = await store.validate("admin-session");
    expect(result).not.toBeNull();
    expect(result?.permission).toBe("admin");
  });

  it("create with permission:'read' reads back 'read'", async () => {
    const { store } = createTestStore();
    const now = Date.now();

    await store.create({
      sessionHash: "read-session",
      projectId: "proj-1",
      tokenHash: "tok-read",
      actorName: "read-actor",
      scopes: "read",
      permission: "read",
      expiresAt: now + 3_600_000,
    });

    const result = await store.validate("read-session");
    expect(result?.permission).toBe("read");
  });
});

describe("D1SessionStore migration backfill (AC-2 fail-closed proof)", () => {
  it("pre-existing row reads back permission='read' after 0010 ALTER", () => {
    // Build a pre-migration _sessions table (no permission column)
    const sqlite = new Database(":memory:");
    sqlite.exec(CREATE_SESSIONS_PRE_MIGRATION);

    // Insert a row in the pre-migration schema
    sqlite.exec(`
      INSERT INTO _sessions (session_hash, project_id, token_hash, actor_name, scopes, created_at, expires_at)
      VALUES ('old-session', 'proj-old', 'tok-old', 'old-actor', 'full', ${Date.now()}, ${Date.now() + 3_600_000});
    `);

    // Apply migration 0010 — the actual ALTER TABLE from the migration file
    sqlite.exec(
      "ALTER TABLE _sessions ADD COLUMN permission TEXT NOT NULL DEFAULT 'read';",
    );

    // Assert the pre-existing row now reads back permission = 'read'
    const row = sqlite
      .prepare("SELECT permission FROM _sessions WHERE session_hash = ?")
      .get("old-session") as { permission: string } | undefined;

    expect(row).toBeDefined();
    expect(row?.permission).toBe("read");
  });
});
