import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { describe, expect, it } from "vitest";
import * as agents from "../src/agent-binding-ops";
import { nextRevision } from "../src/config-revision-ops";
import { LATEST_PROJECT_MIGRATION, MIGRATIONS } from "../src/migrations-sql";
import * as transfer from "../src/project-transfer-ops";
import * as schema from "../src/schema";
import { runMigration } from "./helpers";

const AGENT = `INSERT INTO agents (id,name,owner_principal_id,bind_policy,binding_epoch,archived,created_at,updated_at)
  VALUES ('worker','Worker','owner','[]',0,0,1,1)`;
const ROOM = `INSERT INTO rooms (id,name,history_policy,delivery_ttl_seconds,budgets,archived,next_seq,created_at,updated_at)
  VALUES ('general','General','members',60,'{"max_hops":8,"pair_exchanges":10,"agent_wakes":20,"room_wakes":60}',0,0,1,1)`;
const GROUP = `INSERT INTO signal_groups (id,name,created_at,updated_at,created_by_principal_id,created_by_participant_id,updated_by_principal_id,updated_by_participant_id)
  VALUES ('reviewers','Reviewers',1,1,'owner','tab','owner','tab')`;

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

function upTo(raw: Database.Database, version: number) {
  for (const migration of MIGRATIONS.filter((m) => m.version <= version))
    runMigration(raw, migration);
}

describe("settings revision migration", () => {
  it("starts existing rows at revision 1 and is idempotent", () => {
    const raw = new Database(":memory:");
    try {
      upTo(raw, 41);
      raw.exec(AGENT);
      raw.exec(ROOM);
      raw.exec(GROUP);
      const migration = MIGRATIONS.find((m) => m.version === 42);
      if (!migration) throw new Error("Missing migration 42");
      runMigration(raw, migration);
      runMigration(raw, migration);
      const db = drizzle(raw, { schema });
      expect(
        agents.view(db, "worker", {
          principal_id: "owner",
          can_manage: true,
          runtime: null,
        }).agent,
      ).toMatchObject({ revision: 1, profile_selection: null });
      for (const table of ["rooms", "signal_groups"])
        expect(raw.prepare(`SELECT revision FROM ${table}`).get()).toEqual({
          revision: 1,
        });
      // New allocations never collide with the migrated revision 1.
      expect(nextRevision(db)).toBe(2);
      expect(nextRevision(db)).toBe(3);
      expect(LATEST_PROJECT_MIGRATION).toBeGreaterThanOrEqual(42);
    } finally {
      raw.close();
    }
  });

  it("preserves the semantic digest of a v41 backup after upgrading", async () => {
    const raw = new Database(":memory:");
    try {
      upTo(raw, 41);
      raw.exec(AGENT);
      raw.exec(ROOM);
      raw.exec(GROUP);
      const sql = storage(raw);
      const original = await transfer.semanticDigest(sql, 41);
      for (const migration of MIGRATIONS.filter((m) => m.version > 41))
        runMigration(raw, migration);
      expect(await transfer.semanticDigest(sql, 41)).toBe(original);
      expect(await transfer.semanticDigest(sql)).not.toBe(original);
    } finally {
      raw.close();
    }
  });
});
