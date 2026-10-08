import { randomUUID } from "node:crypto";
import { access, readFile, unlink, writeFile } from "node:fs/promises";
import {
  type ArtifactRevision,
  CREDENTIAL_PRESETS,
  type TokenIssueResponse,
} from "@tila/schemas";
import { Hono } from "hono";
import {
  TilaClient,
  createArtifactMethods,
  createClaimMethods,
} from "tila-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProjectRouter } from "../../backend-do/src/project-do-router";
import { drainArtifactLifecycle } from "../../backend-do/src/routes/artifact-lifecycle-routes";
import { flushArtifactCommits } from "../../backend-do/src/routes/artifact-version-routes";
import type { RouterDeps } from "../../backend-do/src/routes/types";
import {
  type TestDb,
  createTestDb,
} from "../../backend-do/test/helpers/create-test-db";
import { createCloudflareClient } from "../../cli/src/lib/cloudflare-client";
import { loadInfraConfig } from "../../cli/src/lib/infra-config";
import { hashToken } from "../../worker/src/lib/hash-token";
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

// Never enable remote writes merely because another live suite has credentials.
describe.skipIf(process.env.TILA_RUN_LIVE_ARTIFACT_TESTS !== "1")(
  "live artifact revision verification",
  () => {
    it("verifies a new disposable project and confirms cleanup", async () => {
      const baseUrl = process.env.TILA_BASE_URL;
      if (!baseUrl) throw new Error("Live verification requires TILA_BASE_URL");
      // These Node CLI helpers import interactive modules. Runtime loading
      // keeps Workers' global fetch types out of their Node typecheck.
      const resourcesPath = new URL(
        "../../cli/src/lib/cloudflare-resources.ts",
        import.meta.url,
      ).href;
      const { insertTokenAndProject, queryD1 } = (await import(
        resourcesPath
      )) as {
        insertTokenAndProject: (opts: {
          client: ReturnType<typeof createCloudflareClient>;
          accountId: string;
          databaseId: string;
          tokenHash: string;
          slug: string;
        }) => Promise<void>;
        queryD1: <T = Record<string, unknown>>(
          client: ReturnType<typeof createCloudflareClient>,
          accountId: string,
          databaseId: string,
          sql: string,
          params?: string[],
        ) => Promise<T[]>;
      };
      const provisioningPath = new URL(
        "../../cli/src/lib/provisioning.ts",
        import.meta.url,
      ).href;
      const { generateRawToken, resolveCfApiToken, tilaHome } = (await import(
        provisioningPath
      )) as {
        generateRawToken: () => string;
        resolveCfApiToken: () => string | null;
        tilaHome: () => string;
      };
      const teardownPath = new URL(
        "../../cli/src/lib/teardown.ts",
        import.meta.url,
      ).href;
      const { cleanD1NonTokenRecords, deleteD1TokenRecord } = (await import(
        teardownPath
      )) as {
        cleanD1NonTokenRecords: (
          client: ReturnType<typeof createCloudflareClient>,
          accountId: string,
          databaseId: string,
          slug: string,
        ) => Promise<{ ok: boolean }>;
        deleteD1TokenRecord: (
          client: ReturnType<typeof createCloudflareClient>,
          accountId: string,
          databaseId: string,
          slug: string,
        ) => Promise<{ ok: boolean }>;
      };
      const infraConfig = loadInfraConfig(tilaHome());
      if (
        new URL(baseUrl).origin !== new URL(infraConfig.worker_url ?? "").origin
      )
        throw new Error("TILA_BASE_URL must match the configured Worker");
      const cfToken = resolveCfApiToken();
      if (!cfToken)
        throw new Error("Live verification requires CLOUDFLARE_API_TOKEN");
      const cf = createCloudflareClient(cfToken);
      const accountId = infraConfig.account_id;
      const databaseId = infraConfig.d1_database_id;
      const projectId = `artifact-verify-${randomUUID()}`;
      const participantId = `verify-${randomUUID()}`;
      const token = generateRawToken();
      const secrets = [token, cfToken];
      const tokenHash = await hashToken(token, process.env.TILA_HASH_PEPPER);
      const receipt = { projectId, tokenHash, startedAt: Date.now() };
      const client = new TilaClient({
        baseUrl,
        token,
        participantId,
        timeoutMs: 15_000,
      });
      const remoteArtifacts = createArtifactMethods(client, projectId);
      const remoteClaims = createClaimMethods(client, projectId);
      const projectPath = `/projects/${projectId}`;
      const registry = () =>
        queryD1<{
          project_id: string;
          display_name: string;
          created_at: number;
          created_by: string;
          cloudflare_account_id: string;
        }>(
          cf,
          accountId,
          databaseId,
          "SELECT project_id, display_name, created_at, created_by, cloudflare_account_id FROM _projects WHERE project_id = ?",
          [projectId],
        );
      expect(await registry(), "Refuse to reuse an existing project").toEqual(
        [],
      );
      const lifecycle = await cf.r2.buckets.lifecycle.get(
        infraConfig.r2_bucket_name ?? "tila-artifacts",
        { account_id: accountId },
      );
      const expiration = (lifecycle.rules ?? []).filter(
        (rule) => rule.enabled && rule.deleteObjectsTransition,
      );
      expect(expiration.length, "Missing legacy expiration backstop").toBe(1);
      expect(expiration[0]).toMatchObject({
        conditions: { prefix: "produced/" },
        deleteObjectsTransition: {
          condition: { type: "Age", maxAge: 365 * 86400 },
        },
      });

      let provisionAttempted = false;
      let projectTouched = false;
      let uiReadyWritten = false;
      const readyFile = process.env.TILA_LIVE_ARTIFACT_UI_READY_FILE;
      const sanitizedError = (error: unknown) =>
        new Error(
          secrets.reduce(
            (message, secret) => message.replaceAll(secret, "[redacted]"),
            error instanceof Error ? error.message : String(error),
          ),
        );
      async function cleanupLiveProject() {
        try {
          if (provisionAttempted) {
            // Independent guard: compare the in-memory creation receipt with
            // fresh deployed registry state before any destructive action.
            const rows = await registry();
            if (rows.length > 0) {
              expect(rows).toHaveLength(1);
              expect(rows[0]).toMatchObject({
                project_id: receipt.projectId,
                display_name: receipt.projectId,
                created_by: "tila-init",
                cloudflare_account_id: accountId,
              });
              expect(Number(rows[0].created_at)).toBeGreaterThanOrEqual(
                Math.floor(receipt.startedAt / 1000),
              );
              if (projectTouched) {
                const wipe = await client.post<{
                  doWiped: boolean;
                  r2Failed: number;
                  r2Kept: number;
                  r2GcSkipped: boolean;
                }>(
                  `${projectPath}/admin/destroy`,
                  {},
                  { idempotencyKey: "cleanup" },
                );
                expect(wipe).toMatchObject({
                  doWiped: true,
                  r2Failed: 0,
                  r2Kept: 0,
                  r2GcSkipped: false,
                });
                const counts = await client.get<{
                  counts: { domain: Record<string, number> };
                }>(`${projectPath}/admin/store-counts`);
                expect(
                  Object.values(counts.counts.domain).every((n) => n === 0),
                ).toBe(true);
              }
              const cleanup = await cleanD1NonTokenRecords(
                cf,
                accountId,
                databaseId,
                projectId,
              );
              if (!cleanup.ok)
                throw new Error(`D1 cleanup failed for ${projectId}`);
              // The optional browser credential uses canonical service membership.
              // These newer tables are outside the legacy teardown helper.
              await queryD1(
                cf,
                accountId,
                databaseId,
                "DELETE FROM _credential_versions WHERE credential_id IN (SELECT credential_id FROM _credentials WHERE project_id = ?)",
                [projectId],
              );
              for (const table of [
                "_credentials",
                "_credential_events",
                "_service_accounts",
                "_project_memberships",
                "_membership_events",
              ]) {
                await queryD1(
                  cf,
                  accountId,
                  databaseId,
                  `DELETE FROM ${table} WHERE project_id = ?`,
                  [projectId],
                );
                expect(
                  await queryD1(
                    cf,
                    accountId,
                    databaseId,
                    `SELECT count(*) AS remaining FROM ${table} WHERE project_id = ?`,
                    [projectId],
                  ),
                ).toEqual([{ remaining: 0 }]);
              }
              const registrationCleanup = await deleteD1TokenRecord(
                cf,
                accountId,
                databaseId,
                projectId,
              );
              if (!registrationCleanup.ok)
                throw new Error(
                  `Token/registration cleanup failed for ${projectId}`,
                );
              expect(await registry()).toEqual([]);
              expect(
                await queryD1(
                  cf,
                  accountId,
                  databaseId,
                  "SELECT token_hash FROM _tokens WHERE project_id = ? OR token_hash = ?",
                  [projectId, receipt.tokenHash],
                ),
              ).toEqual([]);
              console.info(`Live artifact cleanup confirmed: ${projectId}`);
            }
          }
        } catch (error) {
          throw new Error(
            `Live cleanup incomplete for ${projectId}: ${sanitizedError(error).message}. Inspect its project resources and credentials before retrying`,
          );
        } finally {
          if (uiReadyWritten && readyFile) {
            await unlink(readyFile);
            await unlink(`${readyFile}.done`).catch(
              (error: NodeJS.ErrnoException) => {
                if (error.code !== "ENOENT") throw error;
              },
            );
          }
        }
      }
      const failures: Error[] = [];
      try {
        provisionAttempted = true;
        await insertTokenAndProject({
          client: cf,
          accountId,
          databaseId,
          tokenHash,
          slug: projectId,
        });
        // Authenticate against D1 before accessing any project DO. A pepper
        // mismatch therefore leaves no blob/DO state to clean up.
        await client.get("/api/tokens");
        projectTouched = true;
        await client.post(
          `${projectPath}/schema`,
          {
            definition:
              'schema_version = 1\n[artifacts.report]\nmime_types = ["text/plain"]\nretention_days = 0\n',
          },
          { idempotencyKey: "schema" },
        );
        const claim = await remoteClaims.acquire(
          "artifact:report",
          "exclusive",
          600_000,
          { idempotency_key: "lineage-claim" },
        );
        const writeOptions = {
          kind: "report",
          mimeType: "text/plain",
          lineageId: "report",
          lineageFence: claim.fence,
          tags: ["verification", "first"],
        };
        const firstText = `${projectId}: first revision`;
        const secondText = `${projectId}: second revision`;
        const first = await remoteArtifacts.writeText(firstText, {
          ...writeOptions,
          idempotencyKey: "first",
        });
        const second = await remoteArtifacts.writeText(secondText, {
          ...writeOptions,
          tags: ["second"],
          idempotencyKey: "second",
        });
        const restored = await remoteArtifacts.restore(first.key, {
          fence: claim.fence,
          idempotencyKey: "restore",
        });
        expect(restored.pointer.revision).toBe(3);
        expect(restored.restored_from).toBe(first.key);
        expect(restored.key).not.toBe(first.key);
        expect(restored.pointer.tags).toEqual(writeOptions.tags);
        expect(
          await remoteArtifacts.restore(first.key, {
            fence: claim.fence,
            idempotencyKey: "restore",
          }),
        ).toEqual(restored);
        const identical = await remoteArtifacts.restore(restored.key, {
          fence: claim.fence,
          tags: [],
          idempotencyKey: "identical-restore",
        });
        expect(identical.pointer.revision).toBe(4);
        expect(identical.pointer.sha256).toBe(restored.pointer.sha256);
        expect(identical.pointer.tags).toEqual([]);
        const firstPage = await remoteArtifacts.history(first.key, {
          limit: 1,
        });
        expect(
          firstPage.items.map((p: ArtifactRevision) => p.revision),
        ).toEqual([4]);
        expect(firstPage.meta.total).toBe(4);
        expect(firstPage.meta.next_cursor).toBeTypeOf("string");
        const nextPage = await remoteArtifacts.history(first.key, {
          cursor: firstPage.meta.next_cursor ?? undefined,
        });
        expect(nextPage.items.map((p: ArtifactRevision) => p.revision)).toEqual(
          [3, 2, 1],
        );
        expect((await remoteArtifacts.meta(restored.key)).pointer).toEqual(
          restored.pointer,
        );
        expect((await remoteArtifacts.readText(restored.key)).content).toBe(
          firstText,
        );
        expect(
          await new Response(
            (await remoteArtifacts.download(first.key)).body,
          ).text(),
        ).toBe(firstText);
        expect(
          await new Response(
            (await remoteArtifacts.download(second.key)).body,
          ).text(),
        ).toBe(secondText);
        expect(
          await new Response(
            (await remoteArtifacts.download(identical.key)).body,
          ).text(),
        ).toBe(firstText);
        await client.post(
          `${projectPath}/admin/restart`,
          {},
          { idempotencyKey: "restart" },
        );
        expect((await remoteArtifacts.history(first.key)).meta.total).toBe(4);
        expect((await remoteArtifacts.readText(first.key)).content).toBe(
          firstText,
        );
        // Start at the private versioned prefix. Scanning legacy bucket-wide
        // prefixes could import another project's pointers into this fixture.
        for (let pass = 0; pass < 2; pass++) {
          let cursor: string | undefined = Buffer.from(
            JSON.stringify({ prefix: "versioned" }),
          ).toString("base64url");
          for (let page = 0; ; page++) {
            if (page >= 100)
              throw new Error("Live reconciliation exceeded 100 pages");
            const result = await client.post<{
              nextCursor?: string | null;
              repairErrors: number;
            }>(
              `${projectPath}/artifacts/reconcile`,
              {},
              {
                query: { apply: "true", limit: "1000", cursor },
                idempotencyKey: `reconcile-${pass}-${page}`,
              },
            );
            expect(result.repairErrors).toBe(0);
            cursor = result.nextCursor ?? undefined;
            if (!cursor) break;
          }
          expect((await remoteArtifacts.history(first.key)).meta.total).toBe(4);
          expect(
            await new Response(
              (await remoteArtifacts.download(second.key)).body,
            ).text(),
          ).toBe(secondText);
        }

        // Optional attended browser handoff. The caller chooses the private
        // output path; no token is printed. Exact project acknowledgement is
        // required, and failure/timeout still executes cleanup below.
        if (readyFile) {
          const service = await client.post<{
            service_account: { principal_id: string };
          }>(
            `${projectPath}/service-accounts`,
            {
              name: "browser-verification",
              display_name: "Artifact verification",
              role: "viewer",
            },
            { idempotencyKey: "browser-service" },
          );
          const browserCredential = await client.post<TokenIssueResponse>(
            "/api/tokens",
            {
              name: "browser-verification",
              principal_id: service.service_account.principal_id,
              policy: CREDENTIAL_PRESETS["read-only"],
              expires_at: Math.floor(Date.now() / 1000) + 600,
            },
            { idempotencyKey: "browser-token" },
          );
          secrets.push(browserCredential.token);
          await access(`${readyFile}.done`).then(
            () => {
              throw new Error("Refuse an existing UI acknowledgement");
            },
            (error: NodeJS.ErrnoException) => {
              if (error.code !== "ENOENT") throw error;
            },
          );
          await writeFile(
            readyFile,
            JSON.stringify({
              projectId,
              token: browserCredential.token,
              firstKey: first.key,
              latestKey: identical.key,
              url: `${baseUrl}/p/${projectId}/artifacts/${encodeURIComponent(identical.key)}`,
            }),
            { mode: 0o600, flag: "wx" },
          );
          uiReadyWritten = true;
          console.info(
            `Live artifact browser verification ready: ${projectId}`,
          );
          const deadline = Date.now() + 180_000;
          let acknowledged = false;
          while (Date.now() < deadline) {
            try {
              acknowledged =
                (await readFile(`${readyFile}.done`, "utf8")).trim() ===
                projectId;
              if (acknowledged) break;
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT")
                throw error;
            }
            await new Promise((resolve) => setTimeout(resolve, 1000));
          }
          expect(
            acknowledged,
            "Browser verification was not acknowledged",
          ).toBe(true);
        }

        await remoteArtifacts.delete(identical.key, {
          fence: claim.fence,
          idempotencyKey: "delete-head",
        });
        await expect(
          remoteArtifacts.download(identical.key),
          "Deleted revision download must return 410",
        ).rejects.toMatchObject({ status: 410 });
        await expect(
          remoteArtifacts.restore(identical.key, {
            fence: claim.fence,
            idempotencyKey: "restore-deleted",
          }),
          "Deleted revision restore must return 410",
        ).rejects.toMatchObject({ status: 410 });
        const deleted = (await remoteArtifacts.meta(identical.key)).pointer;
        expect(deleted.tombstoned).toBe(1);
        expect((await remoteArtifacts.history(identical.key)).meta.total).toBe(
          4,
        );
        expect((await remoteArtifacts.readText(restored.key)).content).toBe(
          firstText,
        );
        expect((await remoteArtifacts.meta(second.key)).pointer.tags).toEqual([
          "second",
        ]);
        console.info(`Live artifact API verification passed: ${projectId}`);
      } catch (error) {
        failures.push(sanitizedError(error));
      }
      try {
        await cleanupLiveProject();
      } catch (error) {
        failures.push(sanitizedError(error));
      }
      if (failures.length)
        throw new AggregateError(
          failures,
          `Live verification failed for ${projectId}: ${failures.map((error) => error.message).join("; ")}`,
        );
    }, 300_000);
  },
);
