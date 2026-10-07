import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProjectRouter } from "../../backend-do/src/project-do-router";
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
