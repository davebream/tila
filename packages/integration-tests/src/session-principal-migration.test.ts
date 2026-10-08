import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { expect, it } from "vitest";
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
it("v23 clears sessions whose immutable principal was never stored", () => {
  const sqlite = new Database(":memory:");
  sqlite.exec(CREATE_SESSIONS_PRE_MIGRATION);
  sqlite.exec(`
      INSERT INTO _sessions (session_hash, project_id, token_hash, actor_name, scopes, created_at, expires_at)
      VALUES ('old-session', 'proj-old', 'tok-old', 'old-actor', 'full', ${Date.now()}, ${Date.now() + 3_600_000});
    `);

  const migration = readFileSync(
    new URL(
      "../../worker/migrations/global/0023_session_principals.sql",
      import.meta.url,
    ),
    "utf8",
  );
  sqlite.exec(migration);

  const count = sqlite
    .prepare("SELECT COUNT(*) AS count FROM _sessions")
    .get() as { count: number };
  const columns = sqlite
    .prepare("PRAGMA table_info(_sessions)")
    .all() as Array<{
    name: string;
  }>;
  expect(count.count).toBe(0);
  expect(columns.map(({ name }) => name)).toContain("principal_id");
});
