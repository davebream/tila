import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { MIGRATIONS } from "../src/migrations-sql";
import { runMigration } from "./helpers";

describe("migration 0026 continuity", () => {
  it("upgrades an existing v25 store without rewriting journal history and retries safely", () => {
    const db = new Database(":memory:");
    try {
      for (const migration of MIGRATIONS.filter(({ version }) => version < 26))
        runMigration(db, migration);
      db.prepare(`INSERT INTO journal (t, kind, resource, actor, data, principal_id, participant_id, environment)
        VALUES (1, 'entity.created', 'task:existing', '', '{}', 'principal', 'participant', '{}')`).run();
      const before = db.prepare("SELECT * FROM journal").all();
      const migration = MIGRATIONS.find(({ version }) => version === 26);
      if (!migration) throw new Error("Missing migration 26");
      runMigration(db, migration);
      db.prepare(
        "INSERT INTO journal_cursors VALUES ('principal', 'participant', 1, 123)",
      ).run();
      runMigration(db, migration);
      expect(db.prepare("SELECT * FROM journal").all()).toEqual(before);
      expect(
        db.prepare("SELECT seq, updated_at FROM journal_cursors").get(),
      ).toEqual({ seq: 1, updated_at: 123 });
      expect(
        db.prepare("SELECT COUNT(*) AS count FROM handoffs").get(),
      ).toEqual({ count: 0 });
      expect(
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'trigger' AND (name LIKE 'transfer_guard_journal_cursors_%' OR name LIKE 'transfer_guard_handoffs_%' OR name LIKE 'transfer_guard_handoff_references_%')",
          )
          .get(),
      ).toEqual({ count: 9 });
    } finally {
      db.close();
    }
  });
});
