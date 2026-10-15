import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { MIGRATIONS, MIGRATION_BOOTSTRAP } from "../src/migrations-sql";
import * as transfer from "../src/project-transfer-ops";
import { insertLegacyDigestRows } from "./fixtures/legacy-digest-rows";
import { runMigration } from "./helpers";

// The oracle is `semanticDigest` of the tag v0.7.0 itself (commit
// fa989a9ebd509525dd262d0d6133c5019c405251) over LEGACY_DIGEST_ROWS at its
// level 40. Computing it with the current code would be circular. Reproduce
// with scripts/generate-legacy-backup-fixtures.mjs (--tree <v0.7.0 checkout>).
const V070_DIGEST =
  "6697e4e5eba9edc3eb03926f38438c6129d1edd4f2a3629076a40e254f89e77e";
// Taken from the parent of the fix (8f5c44dc) over the same rows, so they
// guard that levels 41 and 42 did not move. They differ because migration 42
// adds the agent revision columns that level 41 strips.
const LEVEL_41_DIGEST =
  "9dfd40a000578eb0feee66b7afabe3f897b3ea3be9a1db372101008ac2d4ed16";
const LEVEL_42_DIGEST =
  "946b110b76d38901733576da8a0fe8e0d4b6f56ae7ca7dd77f766bc4cf56f311";

type Raw = InstanceType<typeof Database>;

function database(version = Number.POSITIVE_INFINITY): Raw {
  const raw = new Database(":memory:");
  raw.pragma("foreign_keys = ON");
  raw.exec(MIGRATION_BOOTSTRAP);
  for (const migration of MIGRATIONS.filter((m) => m.version <= version))
    runMigration(raw, migration);
  return raw;
}

function storage(raw: Raw): transfer.ProjectSqlStorage {
  return {
    exec(statement: string, ...bindings: unknown[]) {
      if (/^\s*(SELECT|PRAGMA)/i.test(statement))
        return {
          toArray: () =>
            raw.prepare(statement).all(...bindings) as Record<
              string,
              unknown
            >[],
        };
      if (bindings.length > 0) raw.prepare(statement).run(...bindings);
      else raw.exec(statement);
      return { toArray: () => [] };
    },
  };
}

function upgrade(raw: Raw): void {
  for (const migration of MIGRATIONS.filter((m) => m.version > 40))
    runMigration(raw, migration);
}

/** Copies every table of `source` into an empty, fully migrated database. */
function restoreInto(source: Raw): {
  raw: Raw;
  sql: transfer.ProjectSqlStorage;
} {
  const from = storage(source);
  const tables = Object.fromEntries(
    transfer.PROJECT_BACKUP_TABLES.map((table) => [
      table,
      transfer.readSnapshotPage(from, table, { limit: 1_000 }).rows,
    ]),
  );
  const raw = database();
  const sql = storage(raw);
  raw.transaction(() => transfer.replaceSnapshotRows(sql, tables, 1))();
  return { raw, sql };
}

describe("pre-0.8 semantic digest order", () => {
  it("digests level-40 rows exactly as v0.7.0 did", async () => {
    const raw = database(40);
    insertLegacyDigestRows(raw);
    expect(await transfer.semanticDigest(storage(raw), 40)).toBe(V070_DIGEST);
    raw.close();
  });

  it("keeps the historical digest and the 41 and 42 digests after upgrading", async () => {
    const raw = database(40);
    insertLegacyDigestRows(raw);
    upgrade(raw);
    const sql = storage(raw);
    expect(await transfer.semanticDigest(sql, 40)).toBe(V070_DIGEST);
    expect(await transfer.semanticDigest(sql, 41)).toBe(LEVEL_41_DIGEST);
    expect(await transfer.semanticDigest(sql, 42)).toBe(LEVEL_42_DIGEST);
    expect(await transfer.semanticDigest(sql)).toBe(LEVEL_42_DIGEST);
    expect(V070_DIGEST).not.toBe(LEVEL_41_DIGEST);
    raw.close();
  });

  it("only changes order when records and artifact rows coexist, and only at level 41", async () => {
    const recordsOnly = ["entities", "records"];
    const artifactsOnly = [
      "entities",
      "artifact_lineages",
      "artifact_pointers",
      "artifact_revisions",
      "artifact_reviews",
    ];
    const both = [...new Set([...recordsOnly, ...artifactsOnly])];
    const digests = async (tables: string[]) => {
      const raw = database();
      insertLegacyDigestRows(raw, tables);
      const sql = storage(raw);
      const byLevel = new Map<number, string>();
      for (let level = 30; level <= 42; level += 1)
        byLevel.set(level, await transfer.semanticDigest(sql, level));
      raw.close();
      return byLevel;
    };
    const [records, artifacts, together] = await Promise.all([
      digests(recordsOnly),
      digests(artifactsOnly),
      digests(both),
    ]);
    for (const only of [records, artifacts])
      expect(only.get(40)).toBe(only.get(41));
    expect(together.get(40)).not.toBe(together.get(41));
    // One historical order below 41 and one current order from 41.
    for (let level = 30; level <= 39; level += 1)
      expect(together.get(level)).toBe(together.get(40));
    for (let level = 41; level <= 42; level += 1)
      expect(together.get(level)).toBe(together.get(41));
  });

  it("changes the digest order only: records stay ahead of the artifact tables for export, insert and clear", () => {
    const tables = transfer.PROJECT_BACKUP_TABLES;
    expect(tables.indexOf("records")).toBe(tables.indexOf("entities") + 1);
    expect(tables.indexOf("records")).toBeLessThan(
      tables.indexOf("artifact_pointers"),
    );
    expect(tables.indexOf("artifact_reviews")).toBeLessThan(
      tables.indexOf("_schema_history"),
    );
  });

  it("restores level-40 rows into the current schema and verifies the historical digest", async () => {
    const source = database(40);
    insertLegacyDigestRows(source);
    const { raw, sql } = restoreInto(source);
    expect(raw.pragma("foreign_key_check")).toEqual([]);
    expect(await transfer.semanticDigest(sql, 40)).toBe(V070_DIGEST);
    source.close();
    raw.close();
  });

  it("rejects a changed row and a wrong level for a verified legacy restore", async () => {
    const source = database(40);
    insertLegacyDigestRows(source);
    const { raw, sql } = restoreInto(source);
    // Verified at its own level, so the failures below are not vacuous.
    expect(await transfer.semanticDigest(sql, 40)).toBe(V070_DIGEST);
    // A legacy archive finalized at a current level cannot match.
    expect(await transfer.semanticDigest(sql, 41)).not.toBe(V070_DIGEST);
    expect(await transfer.semanticDigest(sql, 42)).not.toBe(V070_DIGEST);
    raw
      .prepare("UPDATE records SET value_json = ? WHERE key = 'main'")
      .run('{"region":"us"}');
    expect(await transfer.semanticDigest(sql, 40)).not.toBe(V070_DIGEST);
    source.close();
    raw.close();
  });
});
