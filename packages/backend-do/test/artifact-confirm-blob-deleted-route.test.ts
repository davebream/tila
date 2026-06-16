import type Database from "better-sqlite3";
/**
 * Tests for POST /artifact/confirm-blob-deleted DO route (Finding #2).
 *
 * The Worker sweep calls this after a successful R2 blob delete. It stamps
 * blob_deleted_at, which is what gates the tombstoned-pointer hard-delete.
 */
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { schema } from "../../ops-sqlite/src";
import { createArtifactRoutes } from "../src/routes/artifact-routes";
import type { RouterDeps } from "../src/routes/types";
import { createTestDb } from "./helpers/create-test-db";

function makeDeps(
  db: BaseSQLiteDatabase<"sync", unknown, typeof schema>,
): RouterDeps {
  return {
    ctx: {} as DurableObjectState,
    db: db as RouterDeps["db"],
    enrichOpts: vi.fn() as RouterDeps["enrichOpts"],
  };
}

let rawDb: InstanceType<typeof Database>;
let db: BaseSQLiteDatabase<"sync", unknown, typeof schema>;

beforeEach(() => {
  const testDb = createTestDb();
  rawDb = testDb.sqlite;
  db = testDb.db;
});

afterEach(() => {
  rawDb.close();
});

function insertTombstonedPointer(r2Key: string): void {
  rawDb
    .prepare(
      `INSERT INTO artifact_pointers(r2_key, resource, kind, sha256, bytes, fence, mime_type, produced_at, produced_by, expires_at, tombstoned, tombstoned_at, blob_deleted_at)
       VALUES(?, NULL, 'output', 'sha-abc', 100, NULL, 'text/markdown', ${Date.now()}, 'test', NULL, 1, ${Date.now()}, NULL)`,
    )
    .run(r2Key);
}

describe("POST /artifact/confirm-blob-deleted", () => {
  it("stamps blob_deleted_at for the given r2_key", async () => {
    const r2Key = "produced/task-1/x.bin";
    insertTombstonedPointer(r2Key);

    const app = createArtifactRoutes(makeDeps(db));
    const res = await app.request("/artifact/confirm-blob-deleted", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ r2_key: r2Key }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    const row = rawDb
      .prepare("SELECT blob_deleted_at FROM artifact_pointers WHERE r2_key = ?")
      .get(r2Key) as { blob_deleted_at: number | null };
    expect(row.blob_deleted_at).not.toBeNull();
  });
});
