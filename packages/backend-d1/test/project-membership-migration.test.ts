import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

const migrationSql = readFileSync(
  new URL(
    "../../worker/migrations/global/0026_project_memberships.sql",
    import.meta.url,
  ),
  "utf8",
);

const LEGACY_SCHEMA = `
  CREATE TABLE _projects (
    project_id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    archived INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE _project_repos (
    project_id TEXT NOT NULL,
    github_host TEXT NOT NULL DEFAULT 'github.com',
    github_owner TEXT NOT NULL,
    github_repo TEXT NOT NULL,
    github_repo_id INTEGER NOT NULL,
    min_read_permission TEXT NOT NULL DEFAULT 'read',
    min_write_permission TEXT NOT NULL DEFAULT 'write',
    max_permission TEXT NOT NULL DEFAULT 'write',
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    created_by TEXT NOT NULL
  );
  CREATE TABLE _sessions (
    session_hash TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    principal_id TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE _admin_grants (
    project_id TEXT NOT NULL,
    github_user_id INTEGER NOT NULL,
    github_login_snapshot TEXT,
    granted_by_user_id INTEGER,
    granted_at INTEGER NOT NULL,
    revoked_at INTEGER,
    identity_host TEXT NOT NULL DEFAULT 'github.com',
    subject_id TEXT NOT NULL
  );
  CREATE TABLE _oidc_principals (
    project_id TEXT NOT NULL,
    issuer TEXT NOT NULL,
    subject TEXT NOT NULL,
    permission TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    created_by TEXT NOT NULL
  );
`;

describe("0026 canonical project membership migration", () => {
  it("preserves existing admission as hybrid and converts active principals", () => {
    const db = new Database(":memory:");
    db.exec(LEGACY_SCHEMA);
    db.prepare("INSERT INTO _projects VALUES (?, ?, ?)").run(
      "proj-1",
      "Project One",
      0,
    );
    db.prepare(
      "INSERT INTO _project_repos VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      "proj-1",
      "github.com",
      "acme",
      "app",
      42,
      "read",
      "write",
      "admin",
      1,
      10,
      "bootstrap",
    );
    db.prepare("INSERT INTO _sessions VALUES (?, ?, ?, ?)").run(
      "browser",
      "proj-1",
      "",
      "github:github.com:7",
    );
    db.prepare("INSERT INTO _sessions VALUES (?, ?, ?, ?)").run(
      "bearer",
      "proj-1",
      "hash",
      "github:github.com:7",
    );
    db.prepare(
      "INSERT INTO _admin_grants VALUES (?, ?, ?, ?, ?, NULL, ?, ?)",
    ).run("proj-1", 7, "alice", null, 100, "github.com", "7");
    db.prepare("INSERT INTO _oidc_principals VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      "proj-1",
      "https://issuer.example/",
      "deploy",
      "write",
      1,
      101,
      "seed",
    );

    db.exec(migrationSql);

    expect(db.prepare("SELECT membership_mode FROM _projects").get()).toEqual({
      membership_mode: "hybrid",
    });
    expect(
      db
        .prepare(
          "SELECT membership_enabled, membership_role_cap FROM _project_repos",
        )
        .get(),
    ).toEqual({ membership_enabled: 1, membership_role_cap: "maintainer" });
    expect(
      db
        .prepare(
          "SELECT provider, subject_kind, role FROM _project_memberships ORDER BY provider",
        )
        .all(),
    ).toEqual([
      { provider: "github", subject_kind: "human", role: "owner" },
      { provider: "oidc", subject_kind: "service", role: "participant" },
    ]);
    expect(db.prepare("SELECT session_hash FROM _sessions").all()).toEqual([
      { session_hash: "bearer" },
    ]);
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM _membership_events").get(),
    ).toEqual({ count: 2 });

    db.prepare(
      "INSERT INTO _projects (project_id, display_name) VALUES (?, ?)",
    ).run("proj-new", "New Project");
    expect(
      db
        .prepare("SELECT membership_mode FROM _projects WHERE project_id = ?")
        .get("proj-new"),
    ).toEqual({ membership_mode: "explicit" });
    db.close();
  });
});
