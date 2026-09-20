import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MIGRATIONS, MIGRATION_BOOTSTRAP } from "../src/migrations-sql";
import { runMigration } from "./helpers";

describe("migration 0025 participant-scoped signals", () => {
  let db: InstanceType<typeof Database>;

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec(MIGRATION_BOOTSTRAP);
    for (const migration of MIGRATIONS.filter(({ version }) => version < 25)) {
      runMigration(db, migration);
    }
  });

  afterEach(() => db.close());

  it("purges legacy display-name signals and creates delivery/group storage", () => {
    db.prepare(
      `INSERT INTO signals
       (id, target, kind, resource, payload, created_by, created_at, expires_at, acked_at)
       VALUES ('sig_legacy', 'display-name', 'info', NULL, '{}', 'sender-name', 1, 2, NULL)`,
    ).run();

    const migration = MIGRATIONS.find(({ version }) => version === 25);
    if (!migration) throw new Error("migration 25 not found");
    runMigration(db, migration);

    expect(db.prepare("SELECT * FROM signals").all()).toEqual([]);
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'signal_%'",
        )
        .all(),
    ).toEqual(
      expect.arrayContaining([
        { name: "signal_deliveries" },
        { name: "signal_group_members" },
        { name: "signal_groups" },
      ]),
    );
    expect(
      (
        db.prepare("PRAGMA table_info(signals)").all() as { name: string }[]
      ).map(({ name }) => name),
    ).toEqual([
      "id",
      "target",
      "kind",
      "resource",
      "payload",
      "sender_principal_id",
      "sender_participant_id",
      "sender_display_name",
      "sender_environment",
      "created_at",
      "expires_at",
    ]);
  });

  it("can be retried without leaving partial schema", () => {
    const migration = MIGRATIONS.find(({ version }) => version === 25);
    if (!migration) throw new Error("migration 25 not found");
    runMigration(db, migration);
    runMigration(db, migration);

    expect(
      db
        .prepare(
          "SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name IN ('signals', 'signal_deliveries', 'signal_groups', 'signal_group_members')",
        )
        .get(),
    ).toEqual({ count: 4 });
  });
});
