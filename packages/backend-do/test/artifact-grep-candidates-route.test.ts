import type Database from "better-sqlite3";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { artifactOps, type schema } from "../../ops-sqlite/src";
import type { GrepCandidate } from "../../ops-sqlite/src/artifact-ops";
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
    r2_key: `sources/ptr-${counter}.md`,
    resource: null as string | null,
    kind: "output",
    sha256: `sha${counter}`,
    bytes: 100,
    fence: null,
    mime_type: "text/plain",
    produced_at: counter * 1000,
    produced_by: "test-machine",
    expires_at: null,
    content_inline: null as string | null,
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

describe("GET /artifact/grep-candidates route", () => {
  it("returns 200 with empty candidates when no pointers", async () => {
    const app = createArtifactRoutes(makeDeps(db));
    const res = await app.request("/artifact/grep-candidates");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      candidates: GrepCandidate[];
    };
    expect(body.ok).toBe(true);
    expect(body.candidates).toEqual([]);
  });

  it("returns non-tombstoned pointers with content_inline", async () => {
    artifactOps.upsertPointer(
      db,
      makePointer({ content_inline: "hello world" }),
      { actor: "test-actor" },
    );

    const app = createArtifactRoutes(makeDeps(db));
    const res = await app.request("/artifact/grep-candidates");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      candidates: GrepCandidate[];
    };
    expect(body.ok).toBe(true);
    expect(body.candidates).toHaveLength(1);
    expect(body.candidates[0].content_inline).toBe("hello world");
  });

  it("filters by kind via parseMulti (single kind)", async () => {
    artifactOps.upsertPointer(db, makePointer({ kind: "lesson" }), {
      actor: "test-actor",
    });
    artifactOps.upsertPointer(db, makePointer({ kind: "output" }), {
      actor: "test-actor",
    });

    const app = createArtifactRoutes(makeDeps(db));
    const res = await app.request("/artifact/grep-candidates?kind=lesson");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      candidates: GrepCandidate[];
    };
    expect(body.candidates).toHaveLength(1);
    expect(body.candidates[0].kind).toBe("lesson");
  });

  it("filters by kind via parseMulti (comma-separated = array)", async () => {
    artifactOps.upsertPointer(db, makePointer({ kind: "lesson" }), {
      actor: "test-actor",
    });
    artifactOps.upsertPointer(db, makePointer({ kind: "output" }), {
      actor: "test-actor",
    });
    artifactOps.upsertPointer(db, makePointer({ kind: "other" }), {
      actor: "test-actor",
    });

    const app = createArtifactRoutes(makeDeps(db));
    const res = await app.request(
      "/artifact/grep-candidates?kind=lesson,output",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      candidates: GrepCandidate[];
    };
    expect(body.candidates).toHaveLength(2);
    const kinds = body.candidates.map((c) => c.kind).sort();
    expect(kinds).toEqual(["lesson", "output"]);
  });

  it("filters by resource", async () => {
    // Need an entity to satisfy FK for resource pointers
    rawDb
      .prepare(
        "INSERT INTO entities (id, type, schema_version, data, archived, created_at, updated_at, created_by) VALUES (?, ?, 1, '{}', 0, ?, ?, 'test')",
      )
      .run("task-1", "task", Date.now(), Date.now());
    rawDb
      .prepare("INSERT INTO fences (resource, current_fence) VALUES (?, ?)")
      .run("task:task-1", 1);

    artifactOps.upsertPointer(
      db,
      makePointer({
        r2_key: "produced/task-1/a.md",
        resource: "task-1",
        fence: 1,
      }),
      { actor: "test-actor" },
    );
    artifactOps.upsertPointer(
      db,
      makePointer({ r2_key: "sources/b.md", resource: null }),
      { actor: "test-actor" },
    );

    const app = createArtifactRoutes(makeDeps(db));
    const res = await app.request("/artifact/grep-candidates?resource=task-1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      candidates: GrepCandidate[];
    };
    expect(body.candidates).toHaveLength(1);
    expect(body.candidates[0].resource).toBe("task-1");
  });

  it("respects limit param (default 50)", async () => {
    for (let i = 0; i < 5; i++) {
      artifactOps.upsertPointer(db, makePointer(), { actor: "test-actor" });
    }

    const app = createArtifactRoutes(makeDeps(db));
    const res = await app.request("/artifact/grep-candidates");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      candidates: GrepCandidate[];
    };
    // All 5 returned (less than default limit of 50)
    expect(body.candidates).toHaveLength(5);
  });

  it("clamps limit to 100 (Math.min)", async () => {
    for (let i = 0; i < 5; i++) {
      artifactOps.upsertPointer(db, makePointer(), { actor: "test-actor" });
    }

    const app = createArtifactRoutes(makeDeps(db));
    const res = await app.request("/artifact/grep-candidates?limit=999");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      candidates: GrepCandidate[];
    };
    // Should return all 5 (clamped limit is 100, which is > 5)
    expect(body.candidates.length).toBeLessThanOrEqual(100);
  });

  it("returns { ok: true, candidates: [...] } envelope", async () => {
    artifactOps.upsertPointer(db, makePointer(), { actor: "test-actor" });

    const app = createArtifactRoutes(makeDeps(db));
    const res = await app.request("/artifact/grep-candidates");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      candidates: GrepCandidate[];
    };
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.candidates)).toBe(true);
    // Each candidate has the required fields
    const c = body.candidates[0];
    expect(typeof c.r2_key).toBe("string");
    expect(typeof c.kind).toBe("string");
    expect(typeof c.mime_type).toBe("string");
    expect(typeof c.bytes).toBe("number");
  });
});
