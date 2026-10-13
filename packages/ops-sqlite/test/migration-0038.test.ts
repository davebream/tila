import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { describe, expect, it } from "vitest";
import { LATEST_PROJECT_MIGRATION, MIGRATIONS } from "../src/migrations-sql";
import * as transfer from "../src/project-transfer-ops";
import * as queue from "../src/queue-ops";
import * as schema from "../src/schema";
import { runMigration } from "./helpers";

const ENTRY = `INSERT INTO queue_entries (id,task_id,state,priority,enqueue_order,required_capabilities,retry_policy,revision,available_at,created_at,updated_at)
  VALUES ('entry','task','queued',0,1,'[]','{"retry_safe":false,"max_attempts":3,"initial_backoff_ms":5000,"max_backoff_ms":300000}',1,1,1,1)`;
const TASK = `INSERT INTO entities(id,type,schema_version,data,created_at,updated_at,created_by)
  VALUES ('task','issue',1,'{}',1,1,'principal')`;

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

describe("queue assigner migration", () => {
  it("adds nullable assigner columns idempotently and keeps legacy entries legacy", () => {
    const raw = new Database(":memory:");
    try {
      for (const migration of MIGRATIONS.filter((m) => m.version < 38))
        runMigration(raw, migration);
      raw.exec(TASK);
      raw.exec(ENTRY);
      const migration = MIGRATIONS.find((m) => m.version === 38);
      if (!migration) throw new Error("Missing migration 38");
      runMigration(raw, migration);
      runMigration(raw, migration);
      const entry = queue.getEntry(drizzle(raw, { schema }), "entry");
      expect(entry.enrolled_by_principal).toBeNull();
      expect(entry.enrolled_by_participant).toBeNull();
      expect(LATEST_PROJECT_MIGRATION).toBe(
        Math.max(...MIGRATIONS.map((m) => m.version)),
      );
    } finally {
      raw.close();
    }
  });

  it("preserves the semantic digest of a v37 backup after upgrading", async () => {
    const raw = new Database(":memory:");
    try {
      for (const migration of MIGRATIONS.filter((m) => m.version <= 37))
        runMigration(raw, migration);
      raw.exec(TASK);
      raw.exec(ENTRY);
      const sql = storage(raw);
      const original = await transfer.semanticDigest(sql, 37);
      for (const migration of MIGRATIONS.filter((m) => m.version > 37))
        runMigration(raw, migration);
      raw.exec(
        "UPDATE queue_entries SET enrolled_by_principal = 'orchestrator'",
      );
      expect(await transfer.semanticDigest(sql, 37)).toBe(original);
      expect(await transfer.semanticDigest(sql)).not.toBe(original);
    } finally {
      raw.close();
    }
  });
});
