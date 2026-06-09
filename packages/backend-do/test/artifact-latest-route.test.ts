import type Database from "better-sqlite3";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { artifactOps, type schema } from "../../ops-sqlite/src";
import { createArtifactRoutes } from "../src/routes/artifact-routes";
import type { RouterDeps } from "../src/routes/types";
import { type TestDb, createTestDb } from "./helpers/create-test-db";

function makeDeps(
  db: BaseSQLiteDatabase<"sync", unknown, typeof schema>,
): RouterDeps {
  return {
    ctx: {} as DurableObjectState,
    db: db as RouterDeps["db"],
    enrichOpts: vi.fn() as RouterDeps["enrichOpts"],
  };
}

let counter = 0;
function makePointer(
  overrides?: Partial<Parameters<typeof artifactOps.upsertPointer>[1]>,
) {
  counter++;
  return {
    r2_key: `keys/ptr-${counter}.md`,
    resource: "task-1",
    kind: "plan",
    sha256: `sha${counter}`,
    bytes: 100,
    fence: null,
    mime_type: "text/markdown",
    produced_at: counter * 1000,
    produced_by: "test-machine",
    expires_at: null,
    ...overrides,
  };
}

let rawDb: InstanceType<typeof Database>;
let db: BaseSQLiteDatabase<"sync", unknown, typeof schema>;

beforeEach(() => {
  counter = 0;
  const testDb = createTestDb();
  rawDb = testDb.sqlite;
  db = testDb.db;
});

afterEach(() => {
  rawDb.close();
});

describe("GET /artifact/latest route", () => {
  it("returns 400 when kind is missing", async () => {
    const app = createArtifactRoutes(makeDeps(db));
    const res = await app.request("/artifact/latest?resource=task-1");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error: { code: string } };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("validation-error");
  });

  it("returns 400 when resource is missing", async () => {
    const app = createArtifactRoutes(makeDeps(db));
    const res = await app.request("/artifact/latest?kind=plan");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error: { code: string } };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("validation-error");
  });

  it("returns 400 when both kind and resource are missing", async () => {
    const app = createArtifactRoutes(makeDeps(db));
    const res = await app.request("/artifact/latest");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error: { code: string } };
    expect(body.ok).toBe(false);
  });

  it("returns 404 when no matching pointer exists", async () => {
    const app = createArtifactRoutes(makeDeps(db));
    const res = await app.request("/artifact/latest?kind=plan&resource=task-1");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe("not-found");
  });

  it("returns 200 with the latest pointer when one exists", async () => {
    const ptr = makePointer();
    artifactOps.upsertPointer(db, ptr, { actor: "agent" });

    const app = createArtifactRoutes(makeDeps(db));
    const res = await app.request("/artifact/latest?kind=plan&resource=task-1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      pointer: { r2_key: string; kind: string };
    };
    expect(body.ok).toBe(true);
    expect(body.pointer.r2_key).toBe(ptr.r2_key);
    expect(body.pointer.kind).toBe("plan");
  });

  it("returns the chain head pointer when supersedes chain exists", async () => {
    const ptr1 = makePointer();
    const ptr2 = makePointer();

    artifactOps.upsertPointer(db, ptr1, { actor: "agent" });
    // ptr2 supersedes ptr1 via autoSupersedes=true
    artifactOps.upsertPointer(
      db,
      ptr2,
      { actor: "agent" },
      undefined,
      null,
      true,
    );

    const app = createArtifactRoutes(makeDeps(db));
    const res = await app.request("/artifact/latest?kind=plan&resource=task-1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      pointer: { r2_key: string };
    };
    expect(body.ok).toBe(true);
    expect(body.pointer.r2_key).toBe(ptr2.r2_key);
  });
});
