import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { describe, expect, it } from "vitest";
import * as attempts from "../src/attempt-ops";
import { MIGRATIONS } from "../src/migrations-sql";
import * as transfer from "../src/project-transfer-ops";
import * as schema from "../src/schema";
import { runMigration } from "./helpers";

const ROWS = `
INSERT INTO entities(id,type,schema_version,data,created_at,updated_at,created_by)
  VALUES ('task','issue',1,'{}',1,1,'principal');
INSERT INTO queue_entries (id,task_id,state,priority,enqueue_order,required_capabilities,retry_policy,revision,available_at,created_at,updated_at)
  VALUES ('entry','task','finished',0,1,'[]','{"retry_safe":false,"max_attempts":3,"initial_backoff_ms":5000,"max_backoff_ms":300000}',2,1,1,1);
INSERT INTO work_attempts (id,entry_id,task_id,resource,principal_id,participant_id,state,revision,fence,outcome,created_at,updated_at,finished_at)
  VALUES ('legacy','entry','task','issue:task','worker','process','terminal',3,4,'{"status":"success","evidence":[],"execution_stopped":true,"unresolved_external_execution":false}',1,2,2);
`;
function storage(db: Database.Database) {
  return {
    exec(statement: string, ...bindings: unknown[]) {
      return {
        toArray: () =>
          db.prepare(statement).all(...bindings) as Record<string, unknown>[],
      };
    },
  };
}

describe("attempt revision migration", () => {
  it("keeps legacy attempts without revisions and adds the owner index idempotently", () => {
    const raw = new Database(":memory:");
    try {
      for (const migration of MIGRATIONS.filter((m) => m.version < 39))
        runMigration(raw, migration);
      raw.exec(ROWS);
      const migration = MIGRATIONS.find((m) => m.version === 39);
      if (!migration) throw new Error("Missing migration 39");
      runMigration(raw, migration);
      runMigration(raw, migration);
      expect(attempts.get(drizzle(raw, { schema }), "legacy").revisions).toBe(
        null,
      );
      expect(
        raw
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'work_attempts_owner'",
          )
          .get(),
      ).toEqual({ name: "work_attempts_owner" });
    } finally {
      raw.close();
    }
  });

  it("preserves the semantic digest of a v38 backup after upgrading", async () => {
    const raw = new Database(":memory:");
    try {
      for (const migration of MIGRATIONS.filter((m) => m.version <= 38))
        runMigration(raw, migration);
      raw.exec(ROWS);
      const sql = storage(raw);
      const original = await transfer.semanticDigest(sql, 38);
      for (const migration of MIGRATIONS.filter((m) => m.version > 38))
        runMigration(raw, migration);
      raw.exec(
        `UPDATE work_attempts SET revisions = '{"finished":{"definition_version":1,"policy_revision":1,"at":2}}'`,
      );
      expect(await transfer.semanticDigest(sql, 38)).toBe(original);
      expect(await transfer.semanticDigest(sql)).not.toBe(original);
    } finally {
      raw.close();
    }
  });
});
