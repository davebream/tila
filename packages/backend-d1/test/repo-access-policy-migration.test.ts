import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

const migrationSql = readFileSync(
  new URL(
    "../../worker/migrations/global/0025_repo_access_policy.sql",
    import.meta.url,
  ),
  "utf8",
);

const LEGACY_SCHEMA = `
  CREATE TABLE _project_repos (
    project_id TEXT NOT NULL,
    github_host TEXT NOT NULL DEFAULT 'github.com',
    github_owner TEXT NOT NULL,
    github_repo TEXT NOT NULL,
    github_repo_id INTEGER NOT NULL,
    min_read_permission TEXT NOT NULL DEFAULT 'read',
    min_write_permission TEXT NOT NULL DEFAULT 'write',
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    created_by TEXT NOT NULL
  );
  CREATE TABLE _sessions (
    session_hash TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    token_hash TEXT NOT NULL
  );
`;

describe("0025 repository access policy migration", () => {
  it("caps existing links at write and invalidates only project GitHub cookies", () => {
    const db = new Database(":memory:");
    db.exec(LEGACY_SCHEMA);
    db.prepare(
      `INSERT INTO _project_repos
        (project_id, github_owner, github_repo, github_repo_id, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("proj-1", "acme", "app", 123, 1, "admin");
    db.prepare("INSERT INTO _sessions VALUES (?, ?, ?)").run(
      "github-project",
      "proj-1",
      "",
    );
    db.prepare("INSERT INTO _sessions VALUES (?, ?, ?)").run(
      "workspace",
      "",
      "",
    );
    db.prepare("INSERT INTO _sessions VALUES (?, ?, ?)").run(
      "token-cookie",
      "proj-1",
      "token-hash",
    );

    db.exec(migrationSql);

    expect(
      db.prepare("SELECT max_permission FROM _project_repos").get(),
    ).toEqual({ max_permission: "write" });
    expect(
      db
        .prepare("SELECT session_hash FROM _sessions ORDER BY session_hash")
        .all(),
    ).toEqual([
      { session_hash: "token-cookie" },
      { session_hash: "workspace" },
    ]);
    db.close();
  });

  it("lets legacy backup-shaped inserts inherit the write database default", () => {
    const db = new Database(":memory:");
    db.exec(LEGACY_SCHEMA);
    db.exec(migrationSql);
    db.prepare(
      `INSERT INTO _project_repos
        (project_id, github_owner, github_repo, github_repo_id, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("proj-1", "acme", "app", 123, 1, "admin");

    expect(
      db.prepare("SELECT max_permission FROM _project_repos").get(),
    ).toEqual({ max_permission: "write" });
    db.close();
  });
});
