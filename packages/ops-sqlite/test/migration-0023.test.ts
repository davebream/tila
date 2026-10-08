import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MIGRATIONS, MIGRATION_BOOTSTRAP } from "../src/migrations-sql";
import { runMigration } from "./helpers";

describe("migration 0023 canonical identity", () => {
  let db: InstanceType<typeof Database>;

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec(MIGRATION_BOOTSTRAP);
    for (const migration of MIGRATIONS.filter(({ version }) => version < 23)) {
      runMigration(db, migration);
    }
  });

  afterEach(() => db.close());

  it("clears unrecoverable leases and presence while preserving fences and historical journal identity", () => {
    db.prepare("INSERT INTO fences(resource, current_fence) VALUES(?, ?)").run(
      "task:legacy",
      41,
    );
    db.prepare(
      `INSERT INTO claims(resource, holder, machine, user, mode, fence, acquired_at, expires_at, metadata)
       VALUES(?, ?, ?, ?, 'exclusive', 41, 100, 200, '{}')`,
    ).run("task:legacy", "machine/user", "machine", "user");
    db.prepare(
      `INSERT INTO presence(machine, last_seen, info) VALUES(?, 100, '{}')`,
    ).run("machine");
    db.prepare(
      `INSERT INTO journal(t, kind, resource, actor, token_id, fence, data, source, source_version)
       VALUES(100, 'entity.created', 'legacy', 'old actor', 'token-id', NULL, '{}', 'cli', '0.1.0')`,
    ).run();

    const migration = MIGRATIONS.find(({ version }) => version === 23);
    if (!migration) throw new Error("migration 23 not found");
    runMigration(db, migration);

    expect(db.prepare("SELECT * FROM claims").all()).toEqual([]);
    expect(db.prepare("SELECT * FROM presence").all()).toEqual([]);
    expect(
      db
        .prepare("SELECT current_fence FROM fences WHERE resource = ?")
        .get("task:legacy"),
    ).toEqual({ current_fence: 41 });
    expect(
      db
        .prepare(
          "SELECT principal_id, participant_id, environment, token_id FROM journal",
        )
        .get(),
    ).toEqual({
      principal_id: "legacy-principal:old actor",
      participant_id: "legacy-event:1",
      environment: JSON.stringify({
        client_name: "cli",
        client_version: "0.1.0",
      }),
      token_id: "token-id",
    });
  });

  it("creates the canonical claim and presence column sets used by every embedded runtime", () => {
    const migration = MIGRATIONS.find(({ version }) => version === 23);
    if (!migration) throw new Error("migration 23 not found");
    runMigration(db, migration);

    const columns = (table: string) =>
      (
        db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
      ).map(({ name }) => name);
    expect(columns("claims")).toEqual([
      "resource",
      "principal_id",
      "participant_id",
      "environment",
      "mode",
      "fence",
      "acquired_at",
      "expires_at",
      "metadata",
    ]);
    expect(columns("presence")).toEqual([
      "principal_id",
      "participant_id",
      "environment",
      "last_seen",
      "info",
    ]);
  });
});
