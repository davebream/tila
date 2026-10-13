import { readFileSync, readdirSync } from "node:fs";
import { ProjectMembershipSchema } from "@tila/schemas";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { splitStatements } from "../../cli/src/lib/d1-migrations";

const migrationName = "0033_project_bootstrap_repair.sql";
const migrationsDir = new URL(
  "../../worker/migrations/global/",
  import.meta.url,
);
const repairSql = readFileSync(new URL(migrationName, migrationsDir), "utf8");
let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  for (const file of readdirSync(migrationsDir)
    .filter((file) => file.endsWith(".sql") && file < migrationName)
    .sort()) {
    db.exec(readFileSync(new URL(file, migrationsDir), "utf8"));
  }
});
afterEach(() => db.close());

function project(id: string, archived = 0) {
  db.prepare(
    "INSERT INTO _projects (project_id, created_at, created_by, cloudflare_account_id, archived) VALUES (?, 0, 'fixture', 'local', ?)",
  ).run(id, archived);
}

function legacy(
  projectId: string,
  userId = 7,
  options: {
    subject?: string;
    host?: string;
    revoked?: boolean;
    actor?: number;
  } = {},
) {
  db.prepare(
    "INSERT INTO _admin_grants (project_id, github_host, github_user_id, github_login_snapshot, granted_by_user_id, granted_at, revoked_at, identity_host, subject_id) VALUES (?, ?, ?, 'alice', ?, 1791820000, ?, ?, ?)",
  ).run(
    projectId,
    options.host ?? "github.com",
    userId,
    options.actor ?? null,
    options.revoked ? 1791820001 : null,
    options.host ?? "github.com",
    options.subject ?? "",
  );
}

function membership(
  projectId: string,
  role = "owner",
  revoked = false,
  subject = "7",
) {
  db.prepare(
    "INSERT INTO _project_memberships (membership_id, project_id, principal_id, provider, identity_host, subject_id, subject_kind, role, granted_by, granted_at, revoked_at) VALUES (?, ?, ?, 'github', 'github.com', ?, 'human', ?, 'fixture', 1234, ?)",
  ).run(
    crypto.randomUUID(),
    projectId,
    `github:github.com:${subject}`,
    subject,
    role,
    revoked ? 1235 : null,
  );
}

function history(projectId: string, action: string) {
  db.prepare(
    "INSERT INTO _membership_events (event_id, project_id, principal_id, actor_principal_id, action, source, occurred_at) VALUES (?, ?, 'github:github.com:7', 'fixture', ?, 'explicit', 1234)",
  ).run(crypto.randomUUID(), projectId, action);
}

describe("0033 project bootstrap repair", () => {
  it("fills only NULL token IDs without changing hashes, permissions or revocation state", () => {
    project("tokens");
    db.exec(`INSERT INTO _tokens (token_hash, project_id, name, scopes, created_at, created_by, token_id, revoked_at)
      VALUES ('missing', 'tokens', 'init', 'full', 1, 'tila-init', NULL, NULL),
        ('revoked', 'tokens', 'old', 'read', 2, 'fixture', NULL, 3),
        ('manual', 'tokens', 'manual', 'full', 4, 'fixture', 'existing-id', NULL)`);
    db.exec(repairSql);
    const rows = db
      .prepare("SELECT * FROM _tokens ORDER BY token_hash")
      .all() as Array<{ token_id: string }>;
    expect(rows).toMatchObject([
      {
        token_hash: "manual",
        token_id: "existing-id",
        scopes: "full",
        revoked_at: null,
        created_at: 4,
      },
      {
        token_hash: "missing",
        token_id: expect.stringMatching(/^[0-9a-f]{32}$/),
        scopes: "full",
        revoked_at: null,
        created_at: 1,
      },
      {
        token_hash: "revoked",
        token_id: expect.stringMatching(/^[0-9a-f]{32}$/),
        scopes: "read",
        revoked_at: 3,
        created_at: 2,
      },
    ]);
    expect(new Set(rows.map((row) => row.token_id)).size).toBe(3);
    db.exec(repairSql);
    expect(
      db.prepare("SELECT * FROM _tokens ORDER BY token_hash").all(),
    ).toEqual(rows);
  });

  it("imports empty and valid legacy subjects as canonical owners with millisecond audit timestamps", () => {
    project("broken");
    project("valid");
    legacy("broken");
    legacy("valid", 8, { subject: "8", host: "GitHub.COM" });
    const legacyRows = db.prepare("SELECT * FROM _admin_grants").all();
    db.exec(repairSql);
    const rows = db
      .prepare("SELECT * FROM _project_memberships ORDER BY project_id")
      .all();
    expect(rows.map((row) => ProjectMembershipSchema.parse(row))).toMatchObject(
      [
        {
          project_id: "broken",
          principal_id: "github:github.com:7",
          subject_id: "7",
          role: "owner",
          display_name: "alice",
          granted_by: "bootstrap:repair-360",
          granted_at: 1791820000000,
        },
        {
          project_id: "valid",
          principal_id: "github:github.com:8",
          subject_id: "8",
          role: "owner",
          granted_at: 1791820000000,
        },
      ],
    );
    const events = db
      .prepare("SELECT * FROM _membership_events ORDER BY project_id")
      .all();
    expect(events).toMatchObject([
      {
        project_id: "broken",
        principal_id: "github:github.com:7",
        action: "grant",
        source: "explicit",
        role: "owner",
        actor_principal_id: "bootstrap:repair-360",
        occurred_at: 1791820000000,
        details_json: '{"repair":"project-bootstrap-360"}',
      },
      {
        project_id: "valid",
        principal_id: "github:github.com:8",
        action: "grant",
        occurred_at: 1791820000000,
      },
    ]);
    db.exec(repairSql);
    expect(
      db
        .prepare("SELECT * FROM _project_memberships ORDER BY project_id")
        .all(),
    ).toEqual(rows);
    expect(
      db.prepare("SELECT * FROM _membership_events ORDER BY project_id").all(),
    ).toEqual(events);
    expect(db.prepare("SELECT * FROM _admin_grants").all()).toEqual(legacyRows);
  });

  it.each([
    ["owner", false],
    ["viewer", false],
    ["maintainer", false],
    ["owner", true],
  ])(
    "preserves an existing canonical %s membership (revoked=%s)",
    (role, revoked) => {
      project("decided");
      legacy("decided");
      membership("decided", String(role), Boolean(revoked));
      const before = db.prepare("SELECT * FROM _project_memberships").all();
      db.exec(repairSql);
      expect(db.prepare("SELECT * FROM _project_memberships").all()).toEqual(
        before,
      );
      expect(
        db.prepare("SELECT COUNT(*) AS count FROM _membership_events").get(),
      ).toEqual({ count: 0 });
    },
  );

  it.each(["grant", "revoke", "role-update"])(
    "honors %s history even when its membership row is absent",
    (action) => {
      project("history");
      legacy("history");
      history("history", action);
      db.exec(repairSql);
      expect(
        db.prepare("SELECT COUNT(*) AS count FROM _project_memberships").get(),
      ).toEqual({ count: 0 });
      expect(
        db.prepare("SELECT COUNT(*) AS count FROM _membership_events").get(),
      ).toEqual({ count: 1 });
    },
  );

  it("honors subject revocation and does not let another project's history block repair", () => {
    project("revoked");
    project("recoverable");
    legacy("revoked");
    legacy("recoverable");
    db.prepare(
      "INSERT INTO _revoked_subjects VALUES ('revoked', 'github.com', '7', 1234)",
    ).run();
    project("history-only");
    history("history-only", "revoke");
    db.exec(repairSql);
    expect(
      db.prepare("SELECT project_id FROM _project_memberships").all(),
    ).toEqual([{ project_id: "recoverable" }]);
  });

  it.each(["", "invalid", "0", "07"])(
    "skips a project with malformed canonical GitHub subject '%s'",
    (subject) => {
      project("malformed");
      legacy("malformed");
      membership("malformed", "owner", false, subject);
      const before = db.prepare("SELECT * FROM _project_memberships").all();
      db.exec(repairSql);
      expect(db.prepare("SELECT * FROM _project_memberships").all()).toEqual(
        before,
      );
    },
  );

  it("skips revoked, non-bootstrap, invalid, foreign-host, conflicting-subject and archived seeds", () => {
    for (const id of [
      "revoked",
      "granted",
      "invalid",
      "foreign",
      "conflict",
      "archived",
    ])
      project(id, id === "archived" ? 1 : 0);
    legacy("revoked", 7, { revoked: true });
    legacy("granted", 7, { actor: 42 });
    legacy("invalid", 0);
    legacy("foreign", 7, { host: "github.example" });
    legacy("conflict", 7, { subject: "99" });
    legacy("archived");
    db.exec(repairSql);
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM _project_memberships").get(),
    ).toEqual({ count: 0 });
  });

  it("finishes the audit event after interruption between grant and event without granting twice", () => {
    project("interrupted");
    legacy("interrupted");
    const statements = splitStatements(repairSql);
    expect(statements).toHaveLength(3);
    db.exec(statements[0]);
    db.exec(statements[1]);
    const before = db.prepare("SELECT * FROM _project_memberships").all();
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM _membership_events").get(),
    ).toEqual({ count: 0 });
    for (const statement of statements) db.exec(statement);
    expect(db.prepare("SELECT * FROM _project_memberships").all()).toEqual(
      before,
    );
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM _membership_events").get(),
    ).toEqual({ count: 1 });
  });
});
