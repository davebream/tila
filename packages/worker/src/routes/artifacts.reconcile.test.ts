/**
 * Unit tests for the POST /reconcile Worker route — C6 R2 blob-existence repair
 * and permission guard.
 *
 * Tests:
 *   1. Read-only token is rejected with 403.
 *   2. Searchable pointer whose R2 blob is absent → DO tombstone called.
 *   3. Searchable pointer whose R2 blob is present → DO tombstone NOT called.
 *   4. R2 head() throws → repairErrors incremented, no abort.
 */
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { requirePermission } from "../middleware/permission";
import type { D1TokenResult, Env, HonoVariables } from "../types";

type AppEnv = { Bindings: Env; Variables: HonoVariables };

// ---------------------------------------------------------------------------
// Minimal mock helpers
// ---------------------------------------------------------------------------

function makeWriteToken(): D1TokenResult {
  return {
    kind: "d1-token",
    projectId: "proj-1",
    name: "test-actor",
    scopes: "full",
    tokenId: "tok-1",
  };
}

function makeReadToken(): D1TokenResult {
  return {
    kind: "d1-token",
    projectId: "proj-1",
    name: "read-actor",
    scopes: "read",
    tokenId: "tok-2",
  };
}

function makeAnalytics() {
  return { writeDataPoint: vi.fn() } as unknown as AnalyticsEngineDataset;
}

function makeCtx() {
  return {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
  } as unknown as ExecutionContext;
}

/** Create a stub DO that records which paths were POSTed. */
function makeDoStub(): {
  stub: DurableObjectStub;
  calls: Array<{ path: string; body: unknown }>;
} {
  const calls: Array<{ path: string; body: unknown }> = [];
  const stub = {
    fetch: vi.fn(async (req: Request) => {
      const url = new URL(req.url);
      let body: unknown = {};
      try {
        body = await req.clone().json();
      } catch {
        // no body
      }
      calls.push({ path: url.pathname, body });

      // Return a plausible response for each path
      if (url.pathname === "/artifact/reconcile") {
        return new Response(
          JSON.stringify({ ok: true, orphans_found: 0, orphans_recovered: 0 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.pathname === "/artifact/searchable-pointers") {
        // Return one searchable pointer
        return new Response(
          JSON.stringify({
            ok: true,
            pointers: [
              {
                r2_key: "produced/T-1/blob.md",
                resource: null,
                kind: "output",
                sha256: "abc",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.pathname === "/artifact/tombstone") {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  } as unknown as DurableObjectStub;
  return { stub, calls };
}

/** Build a minimal Hono app wrapping the reconcile route handler. */
async function makeReconcileApp(opts: {
  tokenResult: D1TokenResult;
  r2Head: (key: string) => Promise<R2Object | null>;
  doStub: DurableObjectStub;
  r2ListWithMetadata?: () => Promise<
    Array<{ key: string; size: number; metadata: Record<string, string> }>
  >;
}) {
  const { artifacts } = await import("./artifacts");

  const mockEnv = {
    DB: {} as D1Database,
    PROJECT: {
      idFromName: vi.fn().mockReturnValue("fake-id"),
      get: vi.fn().mockReturnValue(opts.doStub),
    } as unknown as DurableObjectNamespace,
    ARTIFACTS: {
      head: vi.fn(opts.r2Head),
      list: vi.fn(async () => ({ objects: [] })),
      get: vi.fn(async () => null),
      put: vi.fn(),
      delete: vi.fn(),
      createMultipartUpload: vi.fn(),
      resumeMultipartUpload: vi.fn(),
    } as unknown as R2Bucket,
    ANALYTICS: makeAnalytics(),
  } as unknown as Env;

  const app = new Hono<AppEnv>();
  // Inject minimal context variables
  app.use("/*", async (c, next) => {
    c.set("tokenResult", opts.tokenResult);
    c.set("doStub", opts.doStub);
    c.set("projectId", "proj-1");
    // source/sourceVersion are optional in HonoVariables (string | undefined)
    // leave them unset (undefined) rather than setting null
    return next();
  });
  app.route("/artifacts", artifacts);

  return { app, env: mockEnv };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /artifacts/reconcile — C6 R2 repair + permission guard", () => {
  it("rejects a read-only token with 403 PERMISSION_DENIED", async () => {
    const { stub } = makeDoStub();
    const { app, env } = await makeReconcileApp({
      tokenResult: makeReadToken(),
      r2Head: async () => null,
      doStub: stub,
    });

    const res = await app.fetch(
      new Request("http://localhost/artifacts/reconcile", { method: "POST" }),
      env,
      makeCtx(),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("PERMISSION_DENIED");
  });

  it("tombstones a searchable pointer whose R2 blob is absent (head returns null)", async () => {
    const { stub, calls } = makeDoStub();
    const { app, env } = await makeReconcileApp({
      tokenResult: makeWriteToken(),
      r2Head: async (_key) => null, // blob missing
      doStub: stub,
    });

    const res = await app.fetch(
      new Request("http://localhost/artifacts/reconcile?apply=true", {
        method: "POST",
      }),
      env,
      makeCtx(),
    );
    expect(res.status).toBe(200);

    const body = (await res.json()) as { repairErrors: number };
    expect(body.repairErrors).toBe(0);

    // DO tombstone should have been called
    const tombstoneCall = calls.find((c) => c.path === "/artifact/tombstone");
    expect(tombstoneCall).toBeDefined();
    expect((tombstoneCall?.body as { r2_key: string }).r2_key).toBe(
      "produced/T-1/blob.md",
    );
  });

  it("does NOT tombstone a searchable pointer whose R2 blob is present", async () => {
    const { stub, calls } = makeDoStub();
    const { app, env } = await makeReconcileApp({
      tokenResult: makeWriteToken(),
      r2Head: async () => ({ key: "produced/T-1/blob.md" }) as R2Object, // blob present
      doStub: stub,
    });

    const res = await app.fetch(
      new Request("http://localhost/artifacts/reconcile?apply=true", {
        method: "POST",
      }),
      env,
      makeCtx(),
    );
    expect(res.status).toBe(200);

    const tombstoneCall = calls.find((c) => c.path === "/artifact/tombstone");
    expect(tombstoneCall).toBeUndefined();
  });

  it("increments repairErrors when R2 head() throws, does not abort", async () => {
    const { stub } = makeDoStub();
    const { app, env } = await makeReconcileApp({
      tokenResult: makeWriteToken(),
      r2Head: async () => {
        throw new Error("R2 unavailable");
      },
      doStub: stub,
    });

    const res = await app.fetch(
      new Request("http://localhost/artifacts/reconcile?apply=true", {
        method: "POST",
      }),
      env,
      makeCtx(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { repairErrors: number };
    expect(body.repairErrors).toBe(1);
  });
});
