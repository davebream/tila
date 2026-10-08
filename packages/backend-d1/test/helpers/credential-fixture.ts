import { readFileSync, readdirSync } from "node:fs";
import Database from "better-sqlite3";
import { CredentialStore } from "../../src/credential-store";
import { D1TokenStore } from "../../src/token-store";

export function createCredentialFixture(
  beforeScopedMigration?: (sqlite: Database.Database) => void,
) {
  const sqlite = new Database(":memory:");
  const dir = new URL("../../../worker/migrations/global/", import.meta.url);
  for (const file of readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    if (file.startsWith("0027_")) beforeScopedMigration?.(sqlite);
    sqlite.exec(readFileSync(new URL(file, dir), "utf8"));
  }
  sqlite
    .prepare(
      "INSERT OR IGNORE INTO _projects (project_id, created_at, created_by, cloudflare_account_id, membership_mode) VALUES ('p', 0, 'bootstrap', 'cf', 'explicit')",
    )
    .run();
  function statement(query: string, params: unknown[] = []) {
    const execute = () => {
      const stmt = sqlite.prepare(query);
      if (stmt.reader)
        return {
          results: stmt.all(...params),
          success: true,
          meta: { changes: 0 },
        };
      const result = stmt.run(...params);
      return { results: [], success: true, meta: { changes: result.changes } };
    };
    return {
      bind: (...next: unknown[]) => statement(query, next),
      first: async () => sqlite.prepare(query).get(...params) ?? null,
      all: async () => execute(),
      run: async () => execute(),
      raw: async () =>
        sqlite
          .prepare(query)
          .raw()
          .all(...params),
      execute,
    };
  }
  const db = {
    prepare: (query: string) => statement(query),
    batch: async (statements: Array<ReturnType<typeof statement>>) =>
      sqlite.transaction(() => statements.map((item) => item.execute()))(),
  } as unknown as D1Database;
  return {
    sqlite,
    db,
    store: new CredentialStore(db),
    legacy: new D1TokenStore(db),
  };
}
