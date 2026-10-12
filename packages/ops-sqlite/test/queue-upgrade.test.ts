import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { expect, it } from "vitest";
import { MIGRATIONS, MIGRATION_BOOTSTRAP } from "../src/migrations-sql";
import * as queue from "../src/queue-ops";
import * as schema from "../src/schema";
import { runMigration } from "./helpers";

it("upgrades a prequeue database additively without changing entities, fences or journal history", () => {
  const raw = new Database(":memory:");
  try {
    raw.exec(MIGRATION_BOOTSTRAP);
    for (const migration of MIGRATIONS.filter((m) => m.version < 32))
      runMigration(raw, migration);
    raw
      .prepare("INSERT INTO fences(resource,current_fence) VALUES (?,?)")
      .run("task:existing", 42);
    raw
      .prepare(
        "INSERT INTO journal(t,kind,resource,principal_id,participant_id,actor,data) VALUES (?,?,?,?,?,?,?)",
      )
      .run(
        1,
        "entity.created",
        "task:existing",
        "principal",
        "worker",
        "principal",
        '{"preserved":true}',
      );
    raw
      .prepare(
        "INSERT INTO entities(id,type,schema_version,data,created_at,updated_at,created_by) VALUES (?,?,?,?,?,?,?)",
      )
      .run("existing", "task", 1, '{"status":"open"}', 1, 1, "principal");
    const entityBefore = raw.prepare("SELECT * FROM entities").all();
    const before = raw.prepare("SELECT * FROM journal").all();
    for (const migration of MIGRATIONS.filter((m) => m.version >= 32))
      runMigration(raw, migration);
    const db = drizzle(raw, { schema });
    expect(queue.policy(db)).toMatchObject({
      enabled: false,
      paused: true,
      revision: 0,
    });
    expect(queue.occupancy(db)).toEqual({ execution: 0, wip: 0 });
    expect(raw.prepare("SELECT * FROM journal").all()).toEqual(before);
    expect(raw.prepare("SELECT * FROM entities").all()).toEqual(entityBefore);
    expect(
      raw
        .prepare("SELECT current_fence FROM fences WHERE resource = ?")
        .get("task:existing"),
    ).toEqual({ current_fence: 42 });
    expect(
      raw.prepare("SELECT count(*) AS n FROM queue_operation_receipts").get(),
    ).toEqual({ n: 0 });
  } finally {
    raw.close();
  }
});
