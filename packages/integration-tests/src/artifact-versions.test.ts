import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProjectRouter } from "../../backend-do/src/project-do-router";
import { drainArtifactLifecycle } from "../../backend-do/src/routes/artifact-lifecycle-routes";
import { flushArtifactCommits } from "../../backend-do/src/routes/artifact-version-routes";
import type { RouterDeps } from "../../backend-do/src/routes/types";
import {
  type TestDb,
  createTestDb,
} from "../../backend-do/test/helpers/create-test-db";
import { errorHandler } from "../../worker/src/middleware/error";
import { artifacts } from "../../worker/src/routes/artifacts";
import type { Env, HonoVariables } from "../../worker/src/types";

let db: TestDb;
let app: Hono<{ Bindings: Env; Variables: HonoVariables }>;
let deps: RouterDeps;
let env: Env;
let doApp: ReturnType<typeof createProjectRouter>;
let objects: Map<
  string,
  { bytes: Uint8Array; customMetadata: Record<string, string>; mime: string }
>;
let failCommit: boolean;
let scope: "full" | "read";
let fence: number;
const executionCtx = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
} as unknown as ExecutionContext;
const identity = {
  principal_id: "token:test",
  participant_id: "test-participant",
  environment: {},
  actor: "test",
};
const json = (body: unknown) => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

beforeEach(async () => {
  db = createTestDb();
  objects = new Map();
  failCommit = false;
  scope = "full";
  const bucket = {
    delete: vi.fn(async (key: string) => {
      objects.delete(key);
    }),
    put: vi.fn(async (key: string, body: BodyInit, opts: R2PutOptions = {}) => {
      if (failCommit && key.endsWith(".commit.json"))
        throw new Error("R2 interrupted");
      if (objects.has(key)) return null;
      const bytes = new Uint8Array(await new Response(body).arrayBuffer());
      objects.set(key, {
        bytes,
        customMetadata: opts.customMetadata ?? {},
        mime:
          (opts.httpMetadata as R2HTTPMetadata)?.contentType ??
          "application/octet-stream",
      });
      return { key, size: bytes.byteLength };
    }),
    get: vi.fn(async (key: string) => {
      const obj = objects.get(key);
      if (!obj) return null;
      return {
        body: new Response(new Uint8Array(obj.bytes)).body,
        size: obj.bytes.byteLength,
        customMetadata: obj.customMetadata,
        httpMetadata: { contentType: obj.mime },
        json: async () => JSON.parse(new TextDecoder().decode(obj.bytes)),
      };
    }),
    head: vi.fn(async (key: string) => {
      const obj = objects.get(key);
      return obj
        ? {
            key,
            size: obj.bytes.byteLength,
            customMetadata: obj.customMetadata,
          }
        : null;
    }),
    list: vi.fn(async ({ prefix }: { prefix: string }) => ({
      truncated: false,
      objects: [...objects]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, o]) => ({
          key,
          size: o.bytes.byteLength,
          customMetadata: o.customMetadata,
        })),
    })),
  } as unknown as R2Bucket;
  deps = {
    db: db.db as RouterDeps["db"],
    ctx: {
      storage: {
        sql: {
          exec: (s: string, ...bindings: unknown[]) => ({
            toArray: () => db.sqlite.prepare(s).all(...bindings),
          }),
        },
        getAlarm: vi.fn(async () => null),
        setAlarm: vi.fn(async () => {}),
      },
    } as unknown as DurableObjectState,
    enrichOpts: vi.fn(),
    artifacts: bucket,
  };
  doApp = createProjectRouter(deps);
  const claimed = await doApp.request(
    "/coord/acquire",
    json({
      resource: "artifact:report",
      mode: "exclusive",
      ttl_ms: 60000,
      ...identity,
    }),
  );
  const claimBody = (await claimed.json()) as { fence: number };
  fence = claimBody.fence;
  expect(claimed.status).toBe(200);
  expect(fence).toBeTypeOf("number");
  env = { ARTIFACTS: bucket } as Env;
  app = new Hono();
  app.onError(errorHandler);
  app.use("*", async (c, next) => {
    c.set("tokenResult", {
      kind: "d1-token",
      projectId: "p1",
      name: "test",
      scopes: scope,
      tokenId: "test",
    });
    c.set("projectId", "p1");
    c.set("principalId", identity.principal_id);
    c.set("participantId", identity.participant_id);
    c.set("environment", {});
    c.set("doStub", {
      fetch: (request: Request) => doApp.fetch(request),
    } as DurableObjectStub);
    await next();
  });
  app.route("/", artifacts);
});
afterEach(() => db.sqlite.close());
async function write(content: string, key = crypto.randomUUID()) {
  const init = json({
    content,
    kind: "report",
    lineage_id: "report",
    lineage_fence: fence,
    tags: ["env:test"],
  });
  const response = await app.request(
    "/text",
    { ...init, headers: { ...init.headers, "Idempotency-Key": key } },
    env,
    executionCtx,
  );
  const body = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(200);
  return body as { key: string; pointer: { revision: number } };
}

describe("artifact versions through Worker and DO", () => {
  it("reviews exact revisions through the Worker, enforces permission and CAS, and exposes download state", async () => {
    const first = await write("review me");
    const path = `/~/reviews/${encodeURIComponent(first.key)}`;
    const request = {
      decision: "trusted",
      expected_review_revision: 0,
      reason: "Checked evidence",
    };
    scope = "read";
    expect(
      (await app.request(path, json(request), env, executionCtx)).status,
    ).toBe(403);
    scope = "full";
    expect(
      (
        await app.request(
          path,
          json({ ...request, principal_id: "forged" }),
          env,
          executionCtx,
        )
      ).status,
    ).toBe(400);
    const init = json(request);
    const review = await app.request(
      path,
      { ...init, headers: { ...init.headers, "Idempotency-Key": "review-1" } },
      env,
      executionCtx,
    );
    expect(review.status).toBe(200);
    const saved = await review.json();
    expect(saved).toMatchObject({
      review: {
        state: "trusted",
        review_revision: 1,
        latest: {
          principal_id: identity.principal_id,
          participant_id: identity.participant_id,
        },
      },
    });
    const retry = await app.request(
      path,
      { ...init, headers: { ...init.headers, "Idempotency-Key": "review-1" } },
      env,
      executionCtx,
    );
    expect(await retry.json()).toEqual(saved);
    const stale = await app.request(
      path,
      json({ decision: "rejected", expected_review_revision: 0 }),
      env,
      executionCtx,
    );
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({
      error: { code: "review-conflict" },
    });
    const meta = await app.request(
      `/${encodeURIComponent(first.key)}/meta`,
      undefined,
      env,
      executionCtx,
    );
    expect(await meta.json()).toMatchObject({
      pointer: {
        provenance: { principal_id: identity.principal_id },
        review: { state: "trusted" },
      },
    });
    const blob = await app.request(
      `/${encodeURIComponent(first.key)}`,
      undefined,
      env,
      executionCtx,
    );
    expect(blob.headers.get("X-Tila-Artifact-Review-State")).toBe("trusted");
    expect(await blob.text()).toBe("review me");
    const foreign = await app.request(
      "/~/reviews/versioned%2Fother-project%2Fmissing.txt",
      json(request),
      env,
      executionCtx,
    );
    expect(foreign.status).toBe(404);
    scope = "full";
    const history = await app.request(
      `${path}?limit=1`,
      undefined,
      env,
      executionCtx,
    );
    expect(history.status).toBe(200);
    expect(await history.json()).toMatchObject({
      items: [{ decision: "trusted" }],
    });
  });

  it("round-trips history/meta/restore, encoded slash keys, tags and raw downloads", async () => {
    const first = await write("first");
    await write("second");
    const restoreInit = json({ fence });
    const response = await app.request(
      `/~/restore/${encodeURIComponent(first.key)}`,
      {
        ...restoreInit,
        headers: { ...restoreInit.headers, "Idempotency-Key": "restore" },
      },
      env,
      executionCtx,
    );
    const restored = (await response.json()) as {
      key: string;
      pointer: { revision: number };
      restored_from: string;
    };
    expect(response.status, JSON.stringify(restored)).toBe(200);
    expect(restored.pointer.revision).toBe(3);
    expect(restored.restored_from).toBe(first.key);
    const history = await app.request(
      `/~/history/${encodeURIComponent(first.key)}?limit=1`,
      {},
      env,
      executionCtx,
    );
    const page = (await history.json()) as {
      items: { revision: number }[];
      meta: { next_cursor: string };
    };
    expect(page.items[0].revision).toBe(3);
    const next = await app.request(
      `/~/history/${encodeURIComponent(first.key)}?cursor=${encodeURIComponent(page.meta.next_cursor)}`,
      {},
      env,
      executionCtx,
    );
    expect(
      ((await next.json()) as { items: { revision: number }[] }).items.map(
        (p) => p.revision,
      ),
    ).toEqual([2, 1]);
    vi.mocked(env.ARTIFACTS.get).mockClear();
    const meta = await app.request(
      `/${encodeURIComponent(restored.key)}/meta`,
      {},
      env,
      executionCtx,
    );
    expect(meta.status).toBe(200);
    expect(env.ARTIFACTS.get).not.toHaveBeenCalled();
    const download = await app.request(
      `/${encodeURIComponent(restored.key)}`,
      {},
      env,
      executionCtx,
    );
    expect(await download.text()).toBe("first");
  });

  it("rebuilds history from R2 commit records after losing SQLite and ignores orphan blobs", async () => {
    const first = await write("first");
    const restored = await app.request(
      `/~/restore/${encodeURIComponent(first.key)}`,
      json({ fence }),
      env,
      executionCtx,
    );
    const second = (await restored.json()) as { key: string };
    const orphanKey = "versioned/p1/report/99/orphan.txt";
    objects.set(orphanKey, {
      bytes: new TextEncoder().encode("orphan"),
      customMetadata: {},
      mime: "text/plain",
    });
    db.sqlite.close();
    db = createTestDb();
    deps = { ...deps, db: db.db as RouterDeps["db"] };
    doApp = createProjectRouter(deps);
    const reconcile = await app.request(
      "/reconcile?apply=true",
      { method: "POST" },
      env,
      executionCtx,
    );
    const reconciliation = await reconcile.json();
    expect(reconcile.status, JSON.stringify(reconciliation)).toBe(200);
    const history = await app.request(
      `/~/history/${encodeURIComponent(first.key)}`,
      {},
      env,
      executionCtx,
    );
    const result = (await history.json()) as {
      items: { r2_key: string; revision: number; tags: string[] }[];
    };
    expect(result.items.map((p) => p.r2_key)).toEqual([second.key, first.key]);
    expect(result.items[0].tags).toEqual(["env:test"]);
    expect(
      (
        await app.request(
          `/${encodeURIComponent(orphanKey)}/meta`,
          {},
          env,
          executionCtx,
        )
      ).status,
    ).toBe(404);
  });

  it("rechecks the lineage fence after the blob write and rejects an expired lease", async () => {
    const first = await write("first");
    const originalPut = vi.mocked(env.ARTIFACTS.put).getMockImplementation();
    if (!originalPut) throw new Error("Missing bucket implementation");
    vi.mocked(env.ARTIFACTS.put).mockImplementation(async (...args) => {
      const result = await originalPut(...args);
      db.sqlite
        .prepare("UPDATE claims SET expires_at = 0 WHERE resource = ?")
        .run("artifact:report");
      return result;
    });
    const restore = await app.request(
      `/~/restore/${encodeURIComponent(first.key)}`,
      json({ fence }),
      env,
      executionCtx,
    );
    expect(restore.status).toBe(409);
    expect(
      [...objects.keys()].filter((k) => k.endsWith(".commit.json")),
    ).toHaveLength(1);
    const history = await app.request(
      `/~/history/${encodeURIComponent(first.key)}`,
      {},
      env,
      executionCtx,
    );
    expect(((await history.json()) as { items: unknown[] }).items).toHaveLength(
      1,
    );
  });

  it("recovers accepted publication without the original caller retrying", async () => {
    const first = await write("first");
    failCommit = true;
    const response = await app.request(
      `/~/restore/${encodeURIComponent(first.key)}`,
      json({ fence }),
      env,
      executionCtx,
    );
    expect(response.status).toBe(503);
    const before = await app.request(
      `/~/history/${encodeURIComponent(first.key)}`,
      {},
      env,
      executionCtx,
    );
    expect(((await before.json()) as { items: unknown[] }).items).toHaveLength(
      1,
    );
    failCommit = false;
    await flushArtifactCommits(deps);
    const after = await app.request(
      `/~/history/${encodeURIComponent(first.key)}`,
      {},
      env,
      executionCtx,
    );
    expect(((await after.json()) as { items: unknown[] }).items).toHaveLength(
      2,
    );
  });

  it("rejects bad fences and unavailable blobs without publishing a revision", async () => {
    const first = await write("first");
    const stale = await app.request(
      `/~/restore/${encodeURIComponent(first.key)}`,
      json({ fence: fence + 1 }),
      env,
      executionCtx,
    );
    expect(stale.status).toBe(409);
    objects.delete(first.key);
    const missing = await app.request(
      `/~/restore/${encodeURIComponent(first.key)}`,
      json({ fence }),
      env,
      executionCtx,
    );
    expect(missing.status).toBe(410);
  });

  it("enforces read/write permissions and validates inputs", async () => {
    const first = await write("first");
    expect(
      (
        await app.request(
          `/~/history/${encodeURIComponent(first.key)}`,
          {},
          env,
          executionCtx,
        )
      ).status,
    ).toBe(200);
    scope = "read";
    expect(
      (
        await app.request(
          `/~/restore/${encodeURIComponent(first.key)}`,
          json({ fence }),
          env,
          executionCtx,
        )
      ).status,
    ).toBe(403);
    scope = "full";
    expect(
      (
        await app.request(
          `/~/history/${encodeURIComponent(first.key)}?limit=NaN`,
          {},
          env,
          executionCtx,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await app.request(
          `/~/history/${encodeURIComponent(first.key)}?cursor=bad`,
          {},
          env,
          executionCtx,
        )
      ).status,
    ).toBe(400);
  });
  it("retries an interrupted blob write without allocating another revision", async () => {
    const init = json({
      content: "first",
      kind: "report",
      lineage_id: "report",
      lineage_fence: fence,
    });
    const request = {
      ...init,
      headers: { ...init.headers, "Idempotency-Key": "blob-retry" },
    };
    vi.mocked(env.ARTIFACTS.put).mockRejectedValueOnce(
      new Error("before persistence"),
    );
    const interrupted = await app.request("/text", request, env, executionCtx);
    expect(interrupted.status).toBe(503);
    expect(objects.size).toBe(0);
    const retry = await app.request("/text", request, env, executionCtx);
    expect(retry.status).toBe(200);
    const result = (await retry.json()) as {
      key: string;
      pointer: { revision: number };
    };
    expect(result.pointer.revision).toBe(1);
    const replay = await app.request("/text", request, env, executionCtx);
    expect(await replay.json()).toEqual(result);
    const conflict = await app.request(
      "/text",
      {
        ...request,
        body: JSON.stringify({
          ...JSON.parse(init.body),
          content: "different",
        }),
      },
      env,
      executionCtx,
    );
    expect(conflict.status).toBe(422);
  });

  it("recovers a published commit record before pointer visibility and replays a lost response", async () => {
    const first = await write("first");
    const originalPut = vi.mocked(env.ARTIFACTS.put).getMockImplementation();
    if (!originalPut) throw new Error("Missing bucket implementation");
    let interrupt = true;
    vi.mocked(env.ARTIFACTS.put).mockImplementation(async (...args) => {
      const result = await originalPut(...args);
      if (interrupt && args[0].endsWith(".commit.json")) {
        interrupt = false;
        throw new Error("after persistence, before response");
      }
      return result;
    });
    const init = json({ fence });
    const request = {
      ...init,
      headers: { ...init.headers, "Idempotency-Key": "restore-retry" },
    };
    const path = `/~/restore/${encodeURIComponent(first.key)}`;
    const interrupted = await app.request(path, request, env, executionCtx);
    expect(interrupted.status).toBe(503);
    expect(
      [...objects.keys()].filter((k) => k.endsWith(".commit.json")),
    ).toHaveLength(2);
    const before = await app.request(
      `/~/history/${encodeURIComponent(first.key)}`,
      {},
      env,
      executionCtx,
    );
    expect(((await before.json()) as { items: unknown[] }).items).toHaveLength(
      1,
    );
    const retry = await app.request(path, request, env, executionCtx);
    expect(retry.status).toBe(200);
    const result = (await retry.json()) as {
      key: string;
      pointer: { revision: number };
    };
    expect(result.pointer.revision).toBe(2);
    // The caller lost that successful response and resends the same operation.
    const replay = await app.request(path, request, env, executionCtx);
    expect(await replay.json()).toEqual(result);
    const separate = await app.request(
      path,
      {
        ...request,
        headers: { ...request.headers, "Idempotency-Key": "another-restore" },
      },
      env,
      executionCtx,
    );
    expect(
      ((await separate.json()) as { pointer: { revision: number } }).pointer
        .revision,
    ).toBe(3);
  });
});

describe("versioned deletion through Worker and DO", () => {
  it("requires a fence, returns 410 after deletion, and keeps history after pointer cleanup", async () => {
    const first = await write("first");
    const second = await write("second");
    const url = `/${encodeURIComponent(second.key)}`;
    expect(
      (await app.request(url, { method: "DELETE" }, env, executionCtx)).status,
    ).toBe(400);
    expect(objects.has(second.key)).toBe(true);
    const removed = await app.request(
      `${url}?fence=${fence}`,
      { method: "DELETE", headers: { "Idempotency-Key": "delete-second" } },
      env,
      executionCtx,
    );
    expect(removed.status).toBe(202);
    expect((await app.request(url, {}, env, executionCtx)).status).toBe(410);
    expect((await drainArtifactLifecycle(deps)).errors).toBe(0);
    expect(objects.has(second.key)).toBe(false);
    expect(objects.has(first.key)).toBe(true);
    db.sqlite
      .prepare(
        "UPDATE artifact_pointers SET tombstoned_at = 1 WHERE r2_key = ?",
      )
      .run(second.key);
    await doApp.request("/sweep", json({}));
    expect(
      db.sqlite
        .prepare("SELECT r2_key FROM artifact_pointers WHERE r2_key = ?")
        .get(second.key),
    ).toEqual({ r2_key: second.key });
    const history = await app.request(
      `/~/history/${encodeURIComponent(second.key)}`,
      {},
      env,
      executionCtx,
    );
    const body = (await history.json()) as {
      items: Array<{ blob_deleted_at: number | null }>;
      meta: { total: number };
    };
    expect(body.meta.total).toBe(2);
    expect(body.items[0].blob_deleted_at).toBeTypeOf("number");
    expect(
      (
        await app.request(
          `/~/restore/${encodeURIComponent(second.key)}`,
          json({ fence }),
          env,
          executionCtx,
        )
      ).status,
    ).toBe(410);
  });

  it("rejects expiry of the live head without authorizing blob deletion", async () => {
    const head = await write("head");
    const response = await doApp.request(
      "/artifact/tombstone",
      json({ r2_key: head.key, journal_kind: "artifact.expired", ...identity }),
    );
    expect(response.status).toBe(409);
    expect(objects.has(head.key)).toBe(true);
  });

  it("recovers retirement even when a lineage has no published commit record", async () => {
    objects.set("versioned/p1/report/destroy.json", {
      bytes: new TextEncoder().encode(
        JSON.stringify({
          format: "tila-artifact-lifecycle-v1",
          type: "destroy",
          project_id: "p1",
          lineage_id: "report",
          kind: "report",
          resource: null,
          at: Date.now(),
        }),
      ),
      customMetadata: {},
      mime: "application/json",
    });
    const response = await app.request(
      "/reconcile?apply=true",
      json({}),
      env,
      executionCtx,
    );
    expect(response.status).toBe(200);
    const writeResponse = await app.request(
      "/text",
      json({
        content: "new",
        kind: "report",
        lineage_id: "report",
        lineage_fence: fence,
      }),
      env,
      executionCtx,
    );
    expect(writeResponse.status).toBe(410);
  });

  it("retires a lineage durably, forbids writes, and preserves deletion across R2 reconciliation", async () => {
    const first = await write("first");
    await write("second");
    expect(
      (
        await app.request(
          "/~/destroy/report",
          json({ fence }),
          env,
          executionCtx,
        )
      ).status,
    ).toBe(400);
    const response = await app.request(
      "/~/destroy/report",
      {
        ...json({ fence }),
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "destroy-report",
        },
      },
      env,
      executionCtx,
    );
    expect(response.status).toBe(202);
    expect(objects.has("versioned/p1/report/destroy.json")).toBe(true);
    await drainArtifactLifecycle(deps);
    const later = await app.request(
      "/text",
      json({
        content: "third",
        kind: "report",
        lineage_id: "report",
        lineage_fence: fence,
      }),
      env,
      executionCtx,
    );
    expect(later.status).toBe(410);
    // Erase SQLite state only, retaining R2 recovery records.
    for (const table of [
      "artifact_tags",
      "artifact_pointers",
      "artifact_revision_operations",
      "artifact_revisions",
      "artifact_lifecycle_operations",
      "artifact_lineages",
    ])
      db.sqlite.exec(`DELETE FROM ${table}`);
    const reconcile = await doApp.request(
      "/artifact/version/reconcile",
      json({
        project_id: "p1",
        apply: true,
        keys: [...objects.keys()].filter((key) => key.endsWith(".commit.json")),
      }),
    );
    expect(reconcile.status).toBe(200);
    expect(
      (
        await app.request(
          `/${encodeURIComponent(first.key)}`,
          {},
          env,
          executionCtx,
        )
      ).status,
    ).toBe(410);
    const meta = await app.request(
      `/${encodeURIComponent(first.key)}/meta`,
      {},
      env,
      executionCtx,
    );
    expect(meta.status).toBe(200);
    expect(
      ((await meta.json()) as { pointer: { tombstoned: number } }).pointer
        .tombstoned,
    ).toBe(1);
  });
});
