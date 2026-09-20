import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectMembershipStore } from "../src/project-memberships";

const DDL = `
  CREATE TABLE _projects (
    project_id TEXT PRIMARY KEY,
    display_name TEXT,
    archived INTEGER NOT NULL DEFAULT 0,
    membership_mode TEXT NOT NULL DEFAULT 'explicit'
  );
  CREATE TABLE _project_memberships (
    membership_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    principal_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    identity_host TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    subject_kind TEXT NOT NULL,
    role TEXT NOT NULL,
    display_name TEXT,
    granted_by TEXT NOT NULL,
    granted_at INTEGER NOT NULL,
    revoked_by TEXT,
    revoked_at INTEGER
  );
  CREATE UNIQUE INDEX idx_project_memberships_active
    ON _project_memberships(project_id, principal_id) WHERE revoked_at IS NULL;
  CREATE TABLE _membership_events (
    event_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    principal_id TEXT,
    actor_principal_id TEXT NOT NULL,
    action TEXT NOT NULL,
    source TEXT NOT NULL,
    role TEXT,
    github_repo_id INTEGER,
    details_json TEXT NOT NULL DEFAULT '{}',
    occurred_at INTEGER NOT NULL
  );
  CREATE TABLE _revoked_subjects (
    project_id TEXT NOT NULL,
    identity_host TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    revoked_before INTEGER NOT NULL,
    UNIQUE(project_id, identity_host, subject_id)
  );
  CREATE TABLE _sessions (
    session_hash TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    principal_id TEXT NOT NULL
  );
`;

function d1(sqlite: Database.Database): D1Database {
  function statement(query: string, params: unknown[] = []) {
    return {
      bind: (...next: unknown[]) => statement(query, next),
      async first<T>() {
        return (sqlite.prepare(query).get(...params) as T | undefined) ?? null;
      },
      async all<T>() {
        return { results: sqlite.prepare(query).all(...params) as T[] };
      },
      async run() {
        const info = sqlite.prepare(query).run(...params);
        return { success: true, meta: { changes: info.changes } };
      },
      __run() {
        const info = sqlite.prepare(query).run(...params);
        return { success: true, meta: { changes: info.changes } };
      },
    };
  }
  return {
    prepare: (query: string) => statement(query),
    batch: async (statements: Array<{ __run: () => unknown }>) =>
      sqlite.transaction(() => statements.map((item) => item.__run()))(),
  } as unknown as D1Database;
}

describe("ProjectMembershipStore", () => {
  let sqlite: Database.Database;
  let store: ProjectMembershipStore;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    sqlite.exec(DDL);
    sqlite
      .prepare(
        "INSERT INTO _projects(project_id, display_name, membership_mode) VALUES ('p1', 'One', 'explicit')",
      )
      .run();
    store = new ProjectMembershipStore(d1(sqlite));
  });

  it("resolves explicit membership and ignores mirrored admission in explicit mode", async () => {
    await store.grant({
      projectId: "p1",
      principal: { provider: "github", host: "GitHub.COM", user_id: 42 },
      subjectKind: "human",
      role: "participant",
      actorPrincipalId: "bootstrap:test",
    });

    expect(
      await store.resolve("p1", "github:github.com:42", {
        role: "maintainer",
        githubRepoId: 9,
      }),
    ).toMatchObject({ role: "participant", sources: ["explicit"] });
  });

  it("keeps explicit owners active and caps ordinary admission in mirrored mode", async () => {
    await store.setMode("p1", "github-mirrored", "bootstrap:test");
    await store.grant({
      projectId: "p1",
      principal: { provider: "github", host: "github.com", user_id: 1 },
      subjectKind: "human",
      role: "owner",
      actorPrincipalId: "bootstrap:test",
    });
    await store.grant({
      projectId: "p1",
      principal: { provider: "github", host: "github.com", user_id: 2 },
      subjectKind: "human",
      role: "participant",
      actorPrincipalId: "github:github.com:1",
    });

    expect(await store.resolve("p1", "github:github.com:1")).toMatchObject({
      role: "owner",
    });
    expect(await store.resolve("p1", "github:github.com:2")).toBeNull();
    expect(
      await store.resolve("p1", "github:github.com:2", {
        role: "maintainer",
        githubRepoId: 7,
      }),
    ).toMatchObject({ role: "maintainer", sources: ["github-mirrored"] });
  });

  it("admits only explicit service subjects in service-only mode", async () => {
    await store.setMode("p1", "service-only", "bootstrap:test");
    const human = await store.grant({
      projectId: "p1",
      principal: {
        provider: "oidc",
        issuer: "https://id.example",
        subject: "human",
      },
      subjectKind: "human",
      role: "viewer",
      actorPrincipalId: "bootstrap:test",
    });
    const service = await store.grant({
      projectId: "p1",
      principal: {
        provider: "oidc",
        issuer: "https://id.example",
        subject: "svc",
      },
      subjectKind: "service",
      role: "participant",
      actorPrincipalId: "bootstrap:test",
    });

    expect(await store.resolve("p1", human.membership.principal_id)).toBeNull();
    expect(
      await store.resolve("p1", service.membership.principal_id),
    ).toMatchObject({
      role: "participant",
    });
  });

  it("revokes the grant, tombstones the subject, deletes cookies, and audits atomically", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    try {
      const granted = await store.grant({
        projectId: "p1",
        principal: { provider: "github", host: "github.com", user_id: 42 },
        subjectKind: "human",
        role: "viewer",
        actorPrincipalId: "bootstrap:test",
      });
      sqlite
        .prepare(
          "INSERT INTO _sessions(session_hash, project_id, principal_id) VALUES ('s', 'p1', ?)",
        )
        .run(granted.membership.principal_id);

      const result = await store.revoke({
        projectId: "p1",
        membershipId: granted.membership.membership_id,
        actorPrincipalId: "bootstrap:test",
      });

      expect(result?.revokedSessions).toBe(1);
      expect(
        await store.resolve("p1", granted.membership.principal_id),
      ).toBeNull();
      expect(
        sqlite.prepare("SELECT COUNT(*) AS n FROM _revoked_subjects").get(),
      ).toEqual({ n: 1 });
      expect(
        (await store.listEvents("p1", null, 10)).map((event) => event.action),
      ).toEqual(["revoke", "grant"]);
    } finally {
      now.mockRestore();
    }
  });
});
