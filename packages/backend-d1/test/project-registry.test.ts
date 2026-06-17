import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { D1ProjectRegistry } from "../src/project-registry";

// Minimal DDL for _projects table matching packages/backend-d1/src/schema.ts
const CREATE_PROJECTS = `
  CREATE TABLE IF NOT EXISTS _projects (
    project_id TEXT PRIMARY KEY,
    display_name TEXT,
    created_at INTEGER NOT NULL DEFAULT 0,
    created_by TEXT NOT NULL DEFAULT '',
    cloudflare_account_id TEXT NOT NULL DEFAULT '',
    schema_version INTEGER NOT NULL DEFAULT 1,
    archived INTEGER NOT NULL DEFAULT 0
  );
`;

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec(CREATE_PROJECTS);
  return sqlite;
}

/**
 * Minimal D1Database shim for better-sqlite3.
 * Only implements the prepare().bind().all() chain that Drizzle uses.
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
            // D1 raw() returns rows as arrays of values (column values in order)
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

describe("D1ProjectRegistry.listAllIncludingArchived", () => {
  it("returns both archived and active projects", async () => {
    const sqlite = createTestDb();
    sqlite.exec(`
      INSERT INTO _projects (project_id, cloudflare_account_id, archived) VALUES ('proj-active', 'acc-1', 0);
      INSERT INTO _projects (project_id, cloudflare_account_id, archived) VALUES ('proj-archived', 'acc-1', 1);
    `);
    const d1Shim = createD1Shim(sqlite);
    const registry = new D1ProjectRegistry(d1Shim as unknown as D1Database);

    const all = await registry.listAllIncludingArchived();
    const activeOnly = await registry.listAll();

    expect(all).toHaveLength(2);
    expect(all.map((r) => r.projectId).sort()).toEqual([
      "proj-active",
      "proj-archived",
    ]);
    expect(activeOnly).toHaveLength(1);
    expect(activeOnly[0].projectId).toBe("proj-active");
  });
});

describe("D1ProjectRegistry.getIncludingArchived", () => {
  it("get() returns null for an archived project, getIncludingArchived() returns it", async () => {
    const sqlite = createTestDb();
    sqlite.exec(`
      INSERT INTO _projects (project_id, display_name, cloudflare_account_id, archived) VALUES ('proj-archived', 'Archived Project', 'acc-1', 1);
    `);
    const d1Shim = createD1Shim(sqlite);
    const registry = new D1ProjectRegistry(d1Shim as unknown as D1Database);

    const viaGet = await registry.get("proj-archived");
    const viaGetIncluding =
      await registry.getIncludingArchived("proj-archived");

    expect(viaGet).toBeNull();
    expect(viaGetIncluding).toEqual({
      displayName: "Archived Project",
      cloudflareAccountId: "acc-1",
    });
  });

  it("getIncludingArchived() returns null when the project does not exist", async () => {
    const sqlite = createTestDb();
    const d1Shim = createD1Shim(sqlite);
    const registry = new D1ProjectRegistry(d1Shim as unknown as D1Database);

    const result = await registry.getIncludingArchived("missing");
    expect(result).toBeNull();
  });
});

describe("D1ProjectRegistry.listAll", () => {
  it("returns empty array when no projects exist", async () => {
    const sqlite = createTestDb();
    const d1Shim = createD1Shim(sqlite);
    const registry = new D1ProjectRegistry(d1Shim as unknown as D1Database);
    const result = await registry.listAll();
    expect(result).toEqual([]);
  });

  it("returns only non-archived projects", async () => {
    const sqlite = createTestDb();
    sqlite.exec(`
      INSERT INTO _projects (project_id, cloudflare_account_id, archived) VALUES ('proj-1', 'acc-1', 0);
      INSERT INTO _projects (project_id, cloudflare_account_id, archived) VALUES ('proj-2', 'acc-1', 1);
      INSERT INTO _projects (project_id, cloudflare_account_id, archived) VALUES ('proj-3', 'acc-1', 0);
    `);
    const d1Shim = createD1Shim(sqlite);
    const registry = new D1ProjectRegistry(d1Shim as unknown as D1Database);
    const result = await registry.listAll();
    expect(result).toEqual([{ projectId: "proj-1" }, { projectId: "proj-3" }]);
  });
});
