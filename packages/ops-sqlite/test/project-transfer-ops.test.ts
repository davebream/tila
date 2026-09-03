import { describe, expect, it } from "vitest";
import * as transfer from "../src/project-transfer-ops";
import { createEntity, createTestDb } from "./helpers";

describe("project transfer operations", () => {
  it("orders snapshot rows deterministically and restores journal sequence", async () => {
    const { db, rawDb } = createTestDb();
    createEntity(db, { id: "z" });
    createEntity(db, { id: "a" });
    const sql = {
      exec(statement: string, ...bindings: unknown[]) {
        if (/^\s*(SELECT|PRAGMA)/i.test(statement)) {
          return {
            toArray: () =>
              rawDb.prepare(statement).all(...bindings) as Record<
                string,
                unknown
              >[],
          };
        }
        if (bindings.length > 0) rawDb.prepare(statement).run(...bindings);
        else rawDb.exec(statement);
        return { toArray: () => [] };
      },
    };
    const page = transfer.readSnapshotPage(sql, "entities", { limit: 10 });
    expect(page.rows.map((row) => row.id)).toEqual(["a", "z"]);
    const before = await transfer.semanticDigest(sql);
    const rows = Object.fromEntries(
      transfer.PROJECT_BACKUP_TABLES.map((table) => [
        table,
        transfer.readSnapshotPage(sql, table, { limit: 1_000 }).rows,
      ]),
    );
    transfer.replaceSnapshotRows(sql, rows, 42);
    expect(await transfer.semanticDigest(sql)).toBe(before);
    expect(transfer.journalState(sql).nextSequence).toBe(42);
  });

  it("expires export locks but keeps import locks fail-closed", () => {
    const { rawDb } = createTestDb();
    const sql = {
      exec(statement: string, ...bindings: unknown[]) {
        if (/^\s*(SELECT|PRAGMA)/i.test(statement))
          return {
            toArray: () =>
              rawDb.prepare(statement).all(...bindings) as Record<
                string,
                unknown
              >[],
          };
        if (bindings.length > 0) rawDb.prepare(statement).run(...bindings);
        else rawDb.exec(statement);
        return { toArray: () => [] };
      },
    };
    const now = Date.now();
    const exportTtlMs = 60_000;
    transfer.beginTransfer(sql, {
      sessionId: "export-1",
      mode: "export",
      owner: "test",
      ttlMs: exportTtlMs,
      now,
    });
    expect(() =>
      rawDb
        .prepare(
          "INSERT INTO entities(id, type, schema_version, data, archived, created_at, updated_at, created_by) VALUES ('blocked', 'task', 1, '{}', 0, 1, 1, 'test')",
        )
        .run(),
    ).toThrow("project-maintenance");
    expect(transfer.getTransferState(sql, now + exportTtlMs - 1)?.mode).toBe(
      "export",
    );
    expect(transfer.getTransferState(sql, now + exportTtlMs)).toBeNull();
    transfer.beginTransfer(sql, {
      sessionId: "import-1",
      mode: "import",
      owner: "test",
      now: 200,
    });
    expect(transfer.getTransferState(sql, Number.MAX_SAFE_INTEGER)?.mode).toBe(
      "import",
    );
    expect(transfer.prepareSnapshotRestore(sql, "import-1")).toBe("prepared");
    rawDb
      .prepare(
        "INSERT INTO entities(id, type, schema_version, data, archived, created_at, updated_at, created_by) VALUES ('restored', 'task', 1, '{}', 0, 1, 1, 'test')",
      )
      .run();
    expect(transfer.prepareSnapshotRestore(sql, "import-1")).toBe("replayed");
    expect(
      rawDb.prepare("SELECT id FROM entities WHERE id = 'restored'").get(),
    ).toEqual({ id: "restored" });
  });

  it("accepts matching chunk replays and rejects mismatches", () => {
    const { rawDb } = createTestDb();
    const sql = {
      exec(statement: string, ...bindings: unknown[]) {
        if (/^\s*(SELECT|PRAGMA)/i.test(statement))
          return {
            toArray: () =>
              rawDb.prepare(statement).all(...bindings) as Record<
                string,
                unknown
              >[],
          };
        if (bindings.length > 0) rawDb.prepare(statement).run(...bindings);
        else rawDb.exec(statement);
        return { toArray: () => [] };
      },
    };
    transfer.beginTransfer(sql, {
      sessionId: "import-1",
      mode: "import",
      owner: "test",
    });
    const chunk = {
      sessionId: "import-1",
      section: "do/entities.jsonl",
      chunkIndex: 0,
      sha256: "a".repeat(64),
      bytes: 12,
    };
    expect(transfer.acceptChunk(sql, chunk)).toBe("accepted");
    expect(transfer.acceptChunk(sql, chunk)).toBe("replayed");
    expect(() =>
      transfer.acceptChunk(sql, { ...chunk, sha256: "b".repeat(64) }),
    ).toThrow("does not match");
  });
});
