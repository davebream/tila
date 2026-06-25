import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { revokePrincipalBatch } from "../src/offboard";

// Real DDL mirrored from migrations 0011/0018 (_admin_grants), 0019
// (_revoked_subjects), and 0001/0003 (_tokens). Only the columns the offboard
// batch touches are required.
const DDL = `
  CREATE TABLE _admin_grants (
    project_id TEXT NOT NULL,
    github_host TEXT NOT NULL DEFAULT 'github.com',
    github_user_id INTEGER NOT NULL,
    github_login_snapshot TEXT,
    granted_by_user_id INTEGER,
    granted_at INTEGER NOT NULL,
    revoked_at INTEGER,
    revoked_by_user_id INTEGER,
    identity_host TEXT NOT NULL DEFAULT 'github.com',
    subject_id TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE _revoked_subjects (
    project_id     TEXT    NOT NULL,
    identity_host  TEXT    NOT NULL DEFAULT 'github.com',
    subject_id     TEXT    NOT NULL,
    revoked_before INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX idx_revoked_subjects_principal
    ON _revoked_subjects (project_id, identity_host, subject_id);
  CREATE TABLE _tokens (
    token_hash TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    name TEXT NOT NULL,
    scopes TEXT NOT NULL DEFAULT 'full',
    created_at INTEGER NOT NULL,
    created_by TEXT NOT NULL,
    revoked_at INTEGER,
    revoked_by TEXT,
    token_id TEXT NOT NULL
  );
`;

/**
 * A real-sqlite D1 shim whose `batch()` runs the statements inside a
 * better-sqlite3 transaction — so a throwing statement rolls the whole batch
 * back, exactly like D1's implicit-transaction `batch()`. This lets the unit
 * test PROVE atomicity (real rollback), not merely assert "the call rejected".
 */
function createD1Shim(sqlite: Database.Database) {
  function execSync(query: string, params: unknown[]) {
    const stmt = sqlite.prepare(query);
    if (/returning/i.test(query)) {
      const rows = stmt.all(...(params as unknown[]));
      return { results: rows, success: true, meta: { changes: rows.length } };
    }
    const info = stmt.run(...(params as unknown[]));
    return { results: [], success: true, meta: { changes: info.changes } };
  }
  function makeStatement(query: string, params: unknown[]) {
    return {
      __exec: () => execSync(query, params),
      async all() {
        return execSync(query, params);
      },
      async run() {
        return execSync(query, params);
      },
      async first() {
        const stmt = sqlite.prepare(query);
        return stmt.get(...(params as unknown[])) ?? null;
      },
    };
  }
  return {
    prepare(query: string) {
      return {
        bind(...params: unknown[]) {
          return makeStatement(query, params);
        },
      };
    },
    async batch(stmts: Array<{ __exec: () => unknown }>) {
      const run = sqlite.transaction(() => stmts.map((s) => s.__exec()));
      return run();
    },
  };
}

const NOW_SEC = 1_782_000_000; // EpochSeconds
const NOW_MS = 1_782_000_000_000; // EpochMillis

function seedActiveGrant(
  sqlite: Database.Database,
  projectId: string,
  host: string,
  subjectId: string,
  userId: number,
) {
  sqlite
    .prepare(
      "INSERT INTO _admin_grants (project_id, github_host, github_user_id, granted_at, identity_host, subject_id) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(
      projectId,
      host,
      userId,
      NOW_SEC - 1000,
      host.toLowerCase(),
      subjectId,
    );
}

function seedActiveToken(
  sqlite: Database.Database,
  projectId: string,
  name: string,
  tokenHash: string,
) {
  sqlite
    .prepare(
      "INSERT INTO _tokens (token_hash, project_id, name, created_at, created_by, token_id) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(tokenHash, projectId, name, NOW_SEC - 1000, "seed", `tid-${name}`);
}

describe("revokePrincipalBatch (WI-D)", () => {
  let sqlite: Database.Database;
  let db: D1Database;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    sqlite.exec(DDL);
    db = createD1Shim(sqlite) as unknown as D1Database;
  });

  it("soft-deletes an active grant and arms the tombstone (ms cutoff)", async () => {
    seedActiveGrant(sqlite, "proj-1", "github.com", "12345", 12345);

    const result = await revokePrincipalBatch(db, {
      projectId: "proj-1",
      host: "github.com",
      subject: 12345,
      revokedByUserId: 999,
      revokedBySnapshot: "gh:999",
      nowMsValue: NOW_MS,
      nowSecValue: NOW_SEC,
    });

    expect(result.grantsRevoked).toBe(true);
    expect(result.revokedBefore).toBe(NOW_MS);
    expect(result.tokenHashes).toEqual([]);

    // Grant row soft-deleted.
    const grant = sqlite
      .prepare(
        "SELECT revoked_at, revoked_by_user_id FROM _admin_grants WHERE project_id=? AND subject_id=?",
      )
      .get("proj-1", "12345") as {
      revoked_at: number;
      revoked_by_user_id: number;
    };
    expect(grant.revoked_at).toBe(NOW_SEC);
    expect(grant.revoked_by_user_id).toBe(999);

    // Tombstone armed in MILLISECONDS (the 0019 fail-open trap guard).
    const tomb = sqlite
      .prepare(
        "SELECT revoked_before FROM _revoked_subjects WHERE project_id=? AND identity_host=? AND subject_id=?",
      )
      .get("proj-1", "github.com", "12345") as { revoked_before: number };
    expect(tomb.revoked_before).toBe(NOW_MS);
  });

  it("arms the tombstone even when the principal is not an admin (grantsRevoked=false)", async () => {
    const result = await revokePrincipalBatch(db, {
      projectId: "proj-1",
      host: "github.com",
      subject: 777,
      revokedByUserId: null,
      revokedBySnapshot: "d1-token",
      nowMsValue: NOW_MS,
      nowSecValue: NOW_SEC,
    });

    expect(result.grantsRevoked).toBe(false);
    const tomb = sqlite
      .prepare(
        "SELECT revoked_before FROM _revoked_subjects WHERE project_id=? AND subject_id=?",
      )
      .get("proj-1", "777") as { revoked_before: number };
    expect(tomb.revoked_before).toBe(NOW_MS);
  });

  it("revokes named tokens and returns their hashes (RETURNING) for cache purge", async () => {
    seedActiveToken(sqlite, "proj-1", "ci-bot", "hash-ci");
    seedActiveToken(sqlite, "proj-1", "deploy", "hash-deploy");

    const result = await revokePrincipalBatch(db, {
      projectId: "proj-1",
      host: "github.com",
      subject: 12345,
      revokedByUserId: 999,
      revokedBySnapshot: "gh:999",
      tokenNames: ["ci-bot", "deploy"],
      nowMsValue: NOW_MS,
      nowSecValue: NOW_SEC,
    });

    expect(result.tokenHashes.sort()).toEqual(["hash-ci", "hash-deploy"]);
    const row = sqlite
      .prepare("SELECT revoked_at, revoked_by FROM _tokens WHERE name=?")
      .get("ci-bot") as { revoked_at: number; revoked_by: string };
    expect(row.revoked_at).toBe(NOW_SEC);
    expect(row.revoked_by).toBe("gh:999");
  });

  it("canonicalizes host+subject before binding (mixed-case host, numeric subject)", async () => {
    await revokePrincipalBatch(db, {
      projectId: "proj-1",
      host: "GitHub.COM",
      subject: 12345,
      revokedByUserId: 1,
      revokedBySnapshot: "gh:1",
      nowMsValue: NOW_MS,
      nowSecValue: NOW_SEC,
    });

    // Stored under canonical github.com / "12345".
    const tomb = sqlite
      .prepare(
        "SELECT * FROM _revoked_subjects WHERE project_id=? AND identity_host=? AND subject_id=?",
      )
      .get("proj-1", "github.com", "12345");
    expect(tomb).toBeTruthy();
  });

  it("throws on empty subject before issuing any batch (no writes)", async () => {
    await expect(
      revokePrincipalBatch(db, {
        projectId: "proj-1",
        host: "github.com",
        subject: "   ",
        revokedByUserId: 1,
        revokedBySnapshot: "gh:1",
        nowMsValue: NOW_MS,
        nowSecValue: NOW_SEC,
      }),
    ).rejects.toThrow(/empty subject/);

    const count = sqlite
      .prepare("SELECT COUNT(*) AS n FROM _revoked_subjects")
      .get() as { n: number };
    expect(count.n).toBe(0);
  });

  it("is atomic: a mid-batch failure rolls back the grant soft-delete (no partial writes)", async () => {
    seedActiveGrant(sqlite, "proj-1", "github.com", "12345", 12345);
    // Drop _revoked_subjects so the tombstone INSERT (statement 1) throws AFTER
    // the grant soft-delete (statement 0) — a real transaction must roll back.
    sqlite.exec("DROP TABLE _revoked_subjects");

    await expect(
      revokePrincipalBatch(db, {
        projectId: "proj-1",
        host: "github.com",
        subject: 12345,
        revokedByUserId: 999,
        revokedBySnapshot: "gh:999",
        nowMsValue: NOW_MS,
        nowSecValue: NOW_SEC,
      }),
    ).rejects.toThrow();

    // The grant soft-delete from statement 0 must have rolled back.
    const grant = sqlite
      .prepare("SELECT revoked_at FROM _admin_grants WHERE subject_id=?")
      .get("12345") as { revoked_at: number | null };
    expect(grant.revoked_at).toBeNull();
  });
});
