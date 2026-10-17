import type Database from "better-sqlite3";
/**
 * Tests for POST /artifact/confirm-blob-deleted and its plain-delete caller.
 *
 * The Worker calls this after a successful R2 blob delete. It stamps
 * blob_deleted_at so backups omit deleted bytes while retaining audit metadata.
 */
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { schema } from "../../../ops-sqlite/src";
import { createArtifactRoutes } from "../../src/do/routes/artifact-routes";
import type { RouterDeps } from "../../src/do/routes/types";
import { artifacts } from "../../src/routes/artifacts";
import type { Env, HonoVariables } from "../../src/types";
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

describe("plain deletion metadata across failures", () => {
  it.each(["r2", "confirmation"])(
    "keeps metadata pending after %s failure until retry",
    async (failure) => {
      const key = "sources/fixture.txt";
      db.insert(schema.artifactPointers)
        .values({
          r2_key: key,
          kind: "source",
          sha256: "fixture-sha",
          bytes: 7,
          mime_type: "text/plain",
          produced_at: 1,
          produced_by: "fixture",
          content_inline: "content",
        })
        .run();
      const backend = createArtifactRoutes(makeDeps(db));
      let failConfirmation = failure === "confirmation";
      const stub = {
        fetch: async (req: Request) => {
          if (
            new URL(req.url).pathname === "/artifact/confirm-blob-deleted" &&
            failConfirmation
          ) {
            failConfirmation = false;
            return Response.json({ ok: false }, { status: 503 });
          }
          return backend.request(req);
        },
      } as unknown as DurableObjectStub;
      const remove = vi.fn().mockResolvedValue(undefined);
      if (failure === "r2")
        remove.mockRejectedValueOnce(new Error("R2 unavailable"));
      const app = new Hono<{ Bindings: Env; Variables: HonoVariables }>();
      app.use("*", async (c, next) => {
        c.set("doStub", stub);
        c.set("projectId", "test-project");
        c.set("tokenResult", {
          kind: "d1-token",
          projectId: "test-project",
          name: "fixture",
          scopes: "full",
          tokenId: "fixture-token",
        });
        c.set("principalId", "token:fixture-token");
        c.set("participantId", "fixture");
        c.set("environment", { client_name: "test" });
        return next();
      });
      app.route("/", artifacts);
      const env = {
        ARTIFACTS: { delete: remove },
        ANALYTICS: { writeDataPoint: vi.fn() },
      } as unknown as Env;
      const context = {
        waitUntil: vi.fn(),
        passThroughOnException: vi.fn(),
      } as unknown as ExecutionContext;
      const request = () =>
        app.fetch(
          new Request(`https://worker/${encodeURIComponent(key)}`, {
            method: "DELETE",
          }),
          env,
          context,
        );
      const failed = await request();
      expect(failed.status).toBe(failure === "r2" ? 200 : 502);
      expect(db.select().from(schema.artifactPointers).get()).toMatchObject({
        tombstoned: 1,
        blob_deleted_at: null,
        content_inline: "content",
      });
      const retried = await request();
      expect(retried.status).toBe(200);
      expect(await retried.json()).toEqual({ ok: true });
      expect(db.select().from(schema.artifactPointers).get()).toMatchObject({
        tombstoned: 1,
        blob_deleted_at: expect.any(Number),
        content_inline: null,
      });
      expect(db.select().from(schema.journal).all()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "artifact.tombstoned",
            resource: key,
          }),
        ]),
      );
    },
  );
});
