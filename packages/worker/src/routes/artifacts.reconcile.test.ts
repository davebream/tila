/**
 * Unit tests for the POST /reconcile Worker route — C6 R2 blob-existence repair,
 * permission guard, and composite-cursor pagination (C1).
 *
 * Tests:
 *   1. Read-only token is rejected with 403.
 *   2. Searchable pointer whose R2 blob is absent → DO tombstone called.
 *   3. Searchable pointer whose R2 blob is present → DO tombstone NOT called.
 *   4. R2 head() throws → repairErrors incremented, no abort.
 *   5. Returns nextCursor=null when R2 is empty.
 *   6. Scans at most `limit` objects per call, returns nextCursor when truncated.
 *   7. nextCursor round-trips across produced/→sources/ (multi-page, sequential drain).
 *   8. Oversized limit is clamped to max 1000.
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

      if (url.pathname === "/artifact/reconcile") {
        return new Response(
          JSON.stringify({ ok: true, orphans_found: 0, orphans_recovered: 0 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.pathname === "/artifact/searchable-pointers") {
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

type R2ListResult = {
  objects: Array<{
    key: string;
    size: number;
    customMetadata?: Record<string, string>;
  }>;
  truncated: boolean;
  cursor?: string;
};

type R2ListFn = (opts: {
  prefix?: string;
  limit?: number;
  cursor?: string;
}) => Promise<R2ListResult>;

/** Build a minimal Hono app wrapping the reconcile route handler. */
async function makeReconcileApp(opts: {
  tokenResult: D1TokenResult;
  r2Head: (key: string) => Promise<R2Object | null>;
  doStub: DurableObjectStub;
  r2List?: R2ListFn;
}) {
  const { artifacts } = await import("./artifacts");

  const r2List =
    opts.r2List ?? (async () => ({ objects: [], truncated: false }));

  const mockEnv = {
    DB: {} as D1Database,
    PROJECT: {
      idFromName: vi.fn().mockReturnValue("fake-id"),
      get: vi.fn().mockReturnValue(opts.doStub),
    } as unknown as DurableObjectNamespace,
    ARTIFACTS: {
      head: vi.fn(opts.r2Head),
      list: vi.fn(
        async (listOpts: {
          prefix?: string;
          limit?: number;
          cursor?: string;
        }) => r2List(listOpts),
      ),
      get: vi.fn(async () => null),
      put: vi.fn(),
      delete: vi.fn(),
      createMultipartUpload: vi.fn(),
      resumeMultipartUpload: vi.fn(),
    } as unknown as R2Bucket,
    ANALYTICS: makeAnalytics(),
  } as unknown as Env;

  const app = new Hono<AppEnv>();
  app.use("/*", async (c, next) => {
    c.set("tokenResult", opts.tokenResult);
    c.set("doStub", opts.doStub);
    c.set("projectId", "proj-1");
    return next();
  });
  app.route("/artifacts", artifacts);

  return { app, env: mockEnv };
}

// ---------------------------------------------------------------------------
// Helpers to decode composite cursor (mirrors implementation)
// ---------------------------------------------------------------------------
function decodeCursor(cursor: string): { prefix: string; inner?: string } {
  return JSON.parse(Buffer.from(cursor, "base64url").toString("utf-8"));
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
    expect(body.error.code).toBe("permission-denied");
  });

  it("tombstones a searchable pointer whose R2 blob is absent (head returns null)", async () => {
    const { stub, calls } = makeDoStub();
    const { app, env } = await makeReconcileApp({
      tokenResult: makeWriteToken(),
      r2Head: async (_key) => null,
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
      r2Head: async () => ({ key: "produced/T-1/blob.md" }) as R2Object,
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

// ---------------------------------------------------------------------------
// Composite-cursor pagination tests (C1)
// ---------------------------------------------------------------------------

describe("POST /artifacts/reconcile — composite-cursor pagination (C1)", () => {
  it("returns nextCursor=null and scans 0 objects when R2 is empty", async () => {
    const { stub } = makeDoStub();
    const { app, env } = await makeReconcileApp({
      tokenResult: makeWriteToken(),
      r2Head: async () => null,
      doStub: stub,
      r2List: async () => ({ objects: [], truncated: false }),
    });

    const res = await app.fetch(
      new Request("http://localhost/artifacts/reconcile?limit=5", {
        method: "POST",
      }),
      env,
      makeCtx(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { nextCursor: unknown; scanned: number };
    expect(body.nextCursor).toBeNull();
    expect(body.scanned).toBe(0);
  });

  it("scans at most `limit` R2 objects and returns nextCursor when more remain", async () => {
    const { stub } = makeDoStub();

    const { app, env } = await makeReconcileApp({
      tokenResult: makeWriteToken(),
      r2Head: async () => null,
      doStub: stub,
      r2List: async (o) => {
        if ((o.prefix ?? "").startsWith("produced/")) {
          return {
            objects: [
              { key: "produced/a/f1.md", size: 10 },
              { key: "produced/a/f2.md", size: 10 },
            ],
            truncated: true,
            cursor: "r2-cursor-produced",
          };
        }
        return { objects: [], truncated: false };
      },
    });

    const res = await app.fetch(
      new Request("http://localhost/artifacts/reconcile?limit=2", {
        method: "POST",
      }),
      env,
      makeCtx(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { nextCursor: unknown; scanned: number };

    expect(body.nextCursor).not.toBeNull();
    expect(typeof body.nextCursor).toBe("string");
    expect(body.scanned).toBe(2);

    // Composite cursor must encode prefix=produced
    const decoded = decodeCursor(body.nextCursor as string);
    expect(decoded.prefix).toBe("produced");
    expect(decoded.inner).toBe("r2-cursor-produced");
  });

  it("nextCursor round-trips across produced/→sources/ exhausting all objects exactly once", async () => {
    const { stub } = makeDoStub();

    // produced/: page1=[f1], page2=[f2]; sources/: page1=[g1]; limit=1 per call
    const r2List: R2ListFn = async (o) => {
      const pfx = o.prefix ?? "";
      const cur = o.cursor;
      if (pfx.startsWith("produced/")) {
        if (!cur)
          return {
            objects: [{ key: "produced/a/f1.md", size: 10 }],
            truncated: true,
            cursor: "p2",
          };
        return {
          objects: [{ key: "produced/a/f2.md", size: 10 }],
          truncated: false,
        };
      }
      if (pfx.startsWith("sources/")) {
        if (!cur)
          return {
            objects: [{ key: "sources/b/g1.md", size: 20 }],
            truncated: false,
          };
      }
      return { objects: [], truncated: false };
    };

    const { app, env } = await makeReconcileApp({
      tokenResult: makeWriteToken(),
      r2Head: async () => null,
      doStub: stub,
      r2List,
    });

    // Call 1: limit=1 → f1.md → nextCursor points into produced/ with inner=p2
    const res1 = await app.fetch(
      new Request("http://localhost/artifacts/reconcile?limit=1", {
        method: "POST",
      }),
      env,
      makeCtx(),
    );
    expect(res1.status).toBe(200);
    const b1 = (await res1.json()) as {
      nextCursor: string | null;
      scanned: number;
    };
    expect(b1.scanned).toBe(1);
    expect(b1.nextCursor).not.toBeNull();
    const c1 = b1.nextCursor as string;
    expect(decodeCursor(c1).prefix).toBe("produced");

    // Call 2: limit=1, cursor=c1 → f2.md (second produced/ page) → nextCursor points into sources/
    const res2 = await app.fetch(
      new Request(
        `http://localhost/artifacts/reconcile?limit=1&cursor=${encodeURIComponent(c1)}`,
        { method: "POST" },
      ),
      env,
      makeCtx(),
    );
    expect(res2.status).toBe(200);
    const b2 = (await res2.json()) as {
      nextCursor: string | null;
      scanned: number;
    };
    expect(b2.scanned).toBe(1);
    expect(b2.nextCursor).not.toBeNull();
    const c2 = b2.nextCursor as string;
    // After produced/ exhausted, cursor moves into sources/
    expect(decodeCursor(c2).prefix).toBe("sources");

    // Call 3: limit=1, cursor=c2 → g1.md → nextCursor=null (sources/ exhausted)
    const res3 = await app.fetch(
      new Request(
        `http://localhost/artifacts/reconcile?limit=1&cursor=${encodeURIComponent(c2)}`,
        { method: "POST" },
      ),
      env,
      makeCtx(),
    );
    expect(res3.status).toBe(200);
    const b3 = (await res3.json()) as {
      nextCursor: string | null;
      scanned: number;
    };
    expect(b3.scanned).toBe(1);
    expect(b3.nextCursor).toBeNull();
  });

  it("clamps oversized limit to max 1000", async () => {
    const { stub } = makeDoStub();
    let capturedLimit: number | undefined;

    const { app, env } = await makeReconcileApp({
      tokenResult: makeWriteToken(),
      r2Head: async () => null,
      doStub: stub,
      r2List: async (o) => {
        capturedLimit = o.limit;
        return { objects: [], truncated: false };
      },
    });

    const res = await app.fetch(
      new Request("http://localhost/artifacts/reconcile?limit=99999", {
        method: "POST",
      }),
      env,
      makeCtx(),
    );
    expect(res.status).toBe(200);
    expect(capturedLimit).toBeLessThanOrEqual(1000);
  });
});
