import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

const migrationSql = readFileSync(
  new URL(
    "../../worker/migrations/global/0024_repo_oidc_policy.sql",
    import.meta.url,
  ),
  "utf8",
);

const CREATE_LEGACY_PROJECT_REPOS = `
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
    created_by TEXT NOT NULL,
    oidc_permission TEXT NOT NULL DEFAULT 'write'
  )
`;

describe("0024_repo_oidc_policy migration", () => {
  it("explicitly disables and deprivileges existing repository links", () => {
    const db = new Database(":memory:");
    db.exec(CREATE_LEGACY_PROJECT_REPOS);
    db.prepare(
      `INSERT INTO _project_repos
        (project_id, github_owner, github_repo, github_repo_id, created_at, created_by, oidc_permission)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("proj-1", "acme", "api", 123, 1, "admin", "write");

    db.exec(migrationSql);

    expect(db.prepare("SELECT * FROM _project_repos").get()).toMatchObject({
      oidc_permission: "write",
      oidc_enabled: 0,
      oidc_max_permission: "read",
      oidc_subject_pattern: null,
      oidc_allowed_events: "[]",
      oidc_allowed_refs: "[]",
      oidc_allowed_environments: "[]",
      oidc_allowed_workflows: "[]",
    });
    db.close();
  });

  it("gives rows inserted after migration safe defaults", () => {
    const db = new Database(":memory:");
    db.exec(CREATE_LEGACY_PROJECT_REPOS);
    db.exec(migrationSql);

    db.prepare(
      `INSERT INTO _project_repos
        (project_id, github_owner, github_repo, github_repo_id, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("proj-1", "acme", "web", 456, 1, "admin");

    expect(db.prepare("SELECT * FROM _project_repos").get()).toMatchObject({
      oidc_enabled: 0,
      oidc_max_permission: "read",
      oidc_allowed_events: "[]",
      oidc_allowed_refs: "[]",
      oidc_allowed_environments: "[]",
      oidc_allowed_workflows: "[]",
    });
    db.close();
  });
});
