import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { MIGRATIONS } from "../src/migrations-sql";
import * as transfer from "../src/project-transfer-ops";
import { runMigration } from "./helpers";

describe("artifact provenance migration", () => {
  it("upgrades v28 without inventing legacy principals and retries safely", () => {
    const db = new Database(":memory:");
    try {
      for (const migration of MIGRATIONS.filter((m) => m.version < 29))
        runMigration(db, migration);
      db.prepare(`INSERT INTO artifact_pointers (r2_key,kind,sha256,bytes,mime_type,produced_at,produced_by)
        VALUES ('legacy/file.txt','report','hash',3,'text/plain',123,'display name')`).run();
      const migration = MIGRATIONS.find((m) => m.version === 29);
      if (!migration) throw new Error("Missing migration 29");
      runMigration(db, migration);
      runMigration(db, migration);
      expect(
        db
          .prepare(
            "SELECT produced_by, provenance, revision_creation FROM artifact_pointers",
          )
          .get(),
      ).toEqual({
        produced_by: "display name",
        provenance: null,
        revision_creation: null,
      });
      expect(
        db.prepare("SELECT COUNT(*) AS n FROM artifact_reviews").get(),
      ).toEqual({ n: 0 });
      expect(
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='trigger' AND name LIKE 'transfer_guard_artifact_reviews_%'",
          )
          .get(),
      ).toEqual({ n: 3 });
    } finally {
      db.close();
    }
  });
  it.each([27, 28])(
    "preserves the semantic digest of a v%s backup after upgrading",
    async (version) => {
      const db = new Database(":memory:");
      try {
        for (const migration of MIGRATIONS.filter((m) => m.version <= version))
          runMigration(db, migration);
        db.prepare(`INSERT INTO artifact_pointers (r2_key,kind,sha256,bytes,mime_type,produced_at,produced_by)
        VALUES ('legacy/file.txt','report','hash',3,'text/plain',123,'display name')`).run();
        const sql = {
          exec(statement: string, ...bindings: unknown[]) {
            return {
              toArray: () =>
                db.prepare(statement).all(...bindings) as Record<
                  string,
                  unknown
                >[],
            };
          },
        };
        const original = await transfer.sha256Hex(
          transfer.PROJECT_BACKUP_TABLES.filter(
            (table) => table !== "artifact_reviews",
          )
            .flatMap((table) =>
              transfer
                .readSnapshotPage(sql, table)
                .rows.map(
                  (row) => `${table}\0${transfer.canonicalJson(row)}\n`,
                ),
            )
            .join(""),
        );
        const migration = MIGRATIONS.find((m) => m.version === 29);
        if (!migration) throw new Error("Missing migration 29");
        for (const pending of MIGRATIONS.filter((m) => m.version > version))
          runMigration(db, pending);
        expect(await transfer.semanticDigest(sql, version)).toBe(original);
        expect(await transfer.semanticDigest(sql)).not.toBe(original);
      } finally {
        db.close();
      }
    },
  );
});
