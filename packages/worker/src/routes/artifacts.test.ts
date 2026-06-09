import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { Env, HonoVariables } from "../types";
import {
  artifacts,
  callPointerWithRetry,
  compensateAndRespond,
} from "./artifacts";

function mockStub(responses: Array<Response | Error>): DurableObjectStub {
  let callIndex = 0;
  return {
    fetch: vi.fn(async () => {
      const response = responses[callIndex++];
      if (response instanceof Error) throw response;
      return response;
    }),
  } as unknown as DurableObjectStub;
}

function jsonResponse(body: object, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const POINTER_PAYLOAD = {
  r2_key: "sources/abc123.md",
  resource: null,
  kind: "log",
  sha256: "abc123",
  bytes: 100,
  fence: null,
  mime_type: "text/markdown",
  produced_at: Date.now(),
  produced_by: "test-agent",
  expires_at: null,
  actor: "test-agent",
  search_title: null,
  search_body_text: null,
  actor_token_id: "tok_123",
};

describe("callPointerWithRetry", () => {
  it("retries on throw and succeeds", async () => {
    const stub = mockStub([
      new Error("DO routing error"),
      jsonResponse({ ok: true }),
    ]);

    const result = await callPointerWithRetry(stub, POINTER_PAYLOAD, undefined);

    expect(result.ok).toBe(true);
    expect(result.response?.status).toBe(200);
    expect(stub.fetch).toHaveBeenCalledTimes(2);
  });

  it("retries on 5xx and succeeds on second attempt", async () => {
    const stub = mockStub([
      jsonResponse(
        { ok: false, error: { code: "internal", retryable: true } },
        500,
      ),
      jsonResponse({ ok: true }),
    ]);

    const result = await callPointerWithRetry(stub, POINTER_PAYLOAD, undefined);

    expect(result.ok).toBe(true);
    expect(result.response?.status).toBe(200);
    expect(stub.fetch).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry on 4xx (deterministic failure)", async () => {
    const stub = mockStub([
      jsonResponse(
        {
          ok: false,
          error: {
            code: "undeclared-artifact-kind",
            message: "kind 'foo' not declared",
            retryable: false,
          },
        },
        422,
      ),
    ]);

    const result = await callPointerWithRetry(stub, POINTER_PAYLOAD, undefined);

    expect(result.ok).toBe(false);
    expect(result.response?.status).toBe(422);
    expect(stub.fetch).toHaveBeenCalledTimes(1);
  });

  it("returns failure when both attempts throw", async () => {
    const stub = mockStub([
      new Error("DO routing error"),
      new Error("DO routing error again"),
    ]);

    const result = await callPointerWithRetry(stub, POINTER_PAYLOAD, undefined);

    expect(result.ok).toBe(false);
    expect(result.response).toBeNull();
    if (!result.ok) {
      expect(result.threw).toBe(true);
    }
    expect(stub.fetch).toHaveBeenCalledTimes(2);
  });

  it("returns failure when both attempts return 5xx", async () => {
    const stub = mockStub([
      jsonResponse(
        { ok: false, error: { code: "internal", retryable: true } },
        500,
      ),
      jsonResponse(
        { ok: false, error: { code: "internal", retryable: true } },
        502,
      ),
    ]);

    const result = await callPointerWithRetry(stub, POINTER_PAYLOAD, undefined);

    expect(result.ok).toBe(false);
    expect(result.response?.status).toBe(502);
    if (!result.ok) {
      expect(result.threw).toBe(false);
    }
    expect(stub.fetch).toHaveBeenCalledTimes(2);
  });

  it("returns success on first call without retrying", async () => {
    const stub = mockStub([jsonResponse({ ok: true })]);

    const result = await callPointerWithRetry(stub, POINTER_PAYLOAD, undefined);

    expect(result.ok).toBe(true);
    expect(result.response?.status).toBe(200);
    expect(stub.fetch).toHaveBeenCalledTimes(1);
  });
});

describe("upload route: 4xx forwarding", () => {
  it("forwards DO 422 error to client without retry", async () => {
    const doErrorBody = {
      ok: false,
      error: {
        code: "undeclared-artifact-kind",
        message: "kind 'foo' not declared in tila.schema.toml",
        retryable: false,
      },
    };
    const stub = mockStub([jsonResponse(doErrorBody, 422)]);

    const result = await callPointerWithRetry(stub, POINTER_PAYLOAD, undefined);

    expect(result.ok).toBe(false);
    const body = await result.response?.json();
    expect(body).toEqual(doErrorBody);
    expect(result.response?.status).toBe(422);
  });
});

describe("compensateAndRespond", () => {
  it("returns 502 upload-failed when R2 delete succeeds (blob cleaned up)", async () => {
    const mockR2 = { delete: vi.fn().mockResolvedValue(undefined) };

    const result = await compensateAndRespond(mockR2, "sources/abc123.md");

    expect(result.status).toBe(502);
    expect(result.body.ok).toBe(false);
    expect(result.body.error.code).toBe("upload-failed");
    expect(result.body.error.retryable).toBe(true);
    // upload-failed must NOT include r2Key -- blob was cleaned up
    expect(result.body.error).not.toHaveProperty("r2Key");
    expect(mockR2.delete).toHaveBeenCalledWith("sources/abc123.md");
  });

  it("returns 500 pointer-registration-failed with r2Key when R2 delete also fails", async () => {
    const mockR2 = {
      delete: vi.fn().mockRejectedValue(new Error("R2 delete failed")),
    };

    const result = await compensateAndRespond(mockR2, "sources/abc123.md");

    expect(result.status).toBe(500);
    expect(result.body.ok).toBe(false);
    expect(result.body.error.code).toBe("pointer-registration-failed");
    expect(result.body.error.retryable).toBe(true);
    // pointer-registration-failed MUST include r2Key -- blob exists, client needs recovery key
    expect(result.body.error.r2Key).toBe("sources/abc123.md");
    expect(mockR2.delete).toHaveBeenCalledWith("sources/abc123.md");
  });

  it("does not include r2Key in upload-failed response body", async () => {
    const mockR2 = { delete: vi.fn().mockResolvedValue(undefined) };

    const result = await compensateAndRespond(
      mockR2,
      "produced/task-1/def456.bin",
    );

    expect(result.body.error.code).toBe("upload-failed");
    expect("r2Key" in result.body.error).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Always-on handler-level tests: tag forwarding through the artifact routes
//
// These tests drive the real Hono route handlers with mocked bindings so they
// run in CI without any environment variables set.
// ---------------------------------------------------------------------------

/**
 * Build a test Hono app that wraps the artifacts router and injects mock
 * context variables (tokenResult, doStub, R2 bucket) via middleware.
 *
 * The DO stub records every fetch call so tests can inspect the payload
 * that was forwarded to /artifact/pointer.
 *
 * The env object is passed as the second argument to `app.fetch(req, env, ctx)`
 * following the pattern established in artifacts.reconcile.test.ts.
 */
function buildTestApp(doStubResponses: Array<Response | Error>) {
  // Capture all fetch calls on the DO stub so tests can inspect the bodies.
  const capturedFetchCalls: Array<{ url: string; body: unknown }> = [];
  let callIndex = 0;

  const doStub: DurableObjectStub = {
    fetch: vi.fn(async (req: Request) => {
      const bodyText = await req.text();
      let body: unknown;
      try {
        body = JSON.parse(bodyText);
      } catch {
        body = bodyText;
      }
      capturedFetchCalls.push({ url: req.url, body });

      const response = doStubResponses[callIndex++];
      if (response instanceof Error) throw response;
      return response;
    }),
  } as unknown as DurableObjectStub;

  // Mock R2 bucket: put() always succeeds with size=100 (not 0 = not deduplicated)
  const mockR2Bucket = {
    put: vi.fn().mockResolvedValue({ size: 100 }),
    delete: vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockResolvedValue(null),
    head: vi.fn().mockResolvedValue(null),
    list: vi.fn().mockResolvedValue({ objects: [] }),
  } as unknown as R2Bucket;

  // Minimal analytics stub (fire-and-forget, never load-bearing)
  const mockAnalytics = {
    writeDataPoint: vi.fn(),
  } as unknown as AnalyticsEngineDataset;

  const mockExecutionCtx: ExecutionContext = {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
  } as unknown as ExecutionContext;

  const mockEnv = {
    DB: {} as D1Database,
    PROJECT: {} as DurableObjectNamespace,
    ARTIFACTS: mockR2Bucket,
    ANALYTICS: mockAnalytics,
  } as unknown as Env;

  const tokenResult = {
    kind: "d1-token" as const,
    projectId: "test-project",
    name: "test-agent",
    scopes: "full",
    tokenId: "tok_test",
  };

  const app = new Hono<{ Bindings: Env; Variables: HonoVariables }>();

  // Inject context variables (tokenResult, doStub) via middleware.
  // Bindings (ARTIFACTS, ANALYTICS) are supplied through the env argument to
  // app.fetch(req, env, ctx) — Hono populates c.env from that argument.
  app.use("/*", async (c, next) => {
    c.set("tokenResult", tokenResult);
    c.set("doStub", doStub);
    c.set("projectId", "test-project");
    return next();
  });

  app.route("/", artifacts);

  return { app, mockEnv, mockExecutionCtx, capturedFetchCalls, doStub };
}

describe("artifact multipart upload route — tag forwarding (always-on)", () => {
  it("forwards tags from FormData to the DO pointer payload", async () => {
    const { app, mockEnv, mockExecutionCtx, capturedFetchCalls } = buildTestApp(
      [new Response(JSON.stringify({ ok: true }), { status: 200 })],
    );

    const formData = new FormData();
    const file = new File(["hello world"], "test.txt", { type: "text/plain" });
    formData.append("file", file);
    formData.append("kind", "log");
    formData.append("tags", JSON.stringify(["env:prod", "team:x"]));

    const req = new Request("http://localhost/", {
      method: "POST",
      body: formData,
    });

    const res = await app.fetch(req, mockEnv, mockExecutionCtx);

    expect(res.status).toBe(200);

    // Find the pointer registration call
    const pointerCall = capturedFetchCalls.find((c) =>
      c.url.includes("/artifact/pointer"),
    );
    expect(pointerCall).toBeDefined();
    expect((pointerCall?.body as Record<string, unknown>).tags).toEqual([
      "env:prod",
      "team:x",
    ]);
  });

  it("does not crash when tags field is absent (tags undefined in payload)", async () => {
    const { app, mockEnv, mockExecutionCtx, capturedFetchCalls } = buildTestApp(
      [new Response(JSON.stringify({ ok: true }), { status: 200 })],
    );

    const formData = new FormData();
    const file = new File(["hello"], "no-tags.txt", { type: "text/plain" });
    formData.append("file", file);
    formData.append("kind", "log");
    // No tags field

    const req = new Request("http://localhost/", {
      method: "POST",
      body: formData,
    });

    const res = await app.fetch(req, mockEnv, mockExecutionCtx);
    expect(res.status).toBe(200);

    const pointerCall = capturedFetchCalls.find((c) =>
      c.url.includes("/artifact/pointer"),
    );
    expect(pointerCall).toBeDefined();
    const payload = pointerCall?.body as Record<string, unknown>;
    // tags should be absent or undefined — must NOT be a non-array value
    expect(payload.tags === undefined || Array.isArray(payload.tags)).toBe(
      true,
    );
    if (Array.isArray(payload.tags)) {
      expect(payload.tags).toHaveLength(0);
    }
  });
});

describe("artifact text-write route — tag forwarding (always-on)", () => {
  it("forwards tags from JSON body to the DO pointer payload", async () => {
    const { app, mockEnv, mockExecutionCtx, capturedFetchCalls } = buildTestApp(
      [new Response(JSON.stringify({ ok: true }), { status: 200 })],
    );

    const req = new Request("http://localhost/text", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "# Hello",
        kind: "note",
        mime_type: "text/markdown",
        tags: ["env:staging", "owner:alice"],
      }),
    });

    const res = await app.fetch(req, mockEnv, mockExecutionCtx);
    expect(res.status).toBe(200);

    const pointerCall = capturedFetchCalls.find((c) =>
      c.url.includes("/artifact/pointer"),
    );
    expect(pointerCall).toBeDefined();
    expect((pointerCall?.body as Record<string, unknown>).tags).toEqual([
      "env:staging",
      "owner:alice",
    ]);
  });

  it("does not crash when tags are absent from the text-write body", async () => {
    const { app, mockEnv, mockExecutionCtx, capturedFetchCalls } = buildTestApp(
      [new Response(JSON.stringify({ ok: true }), { status: 200 })],
    );

    const req = new Request("http://localhost/text", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "plain content",
        kind: "log",
        mime_type: "text/plain",
        // no tags
      }),
    });

    const res = await app.fetch(req, mockEnv, mockExecutionCtx);
    expect(res.status).toBe(200);

    const pointerCall = capturedFetchCalls.find((c) =>
      c.url.includes("/artifact/pointer"),
    );
    expect(pointerCall).toBeDefined();
    const payload = pointerCall?.body as Record<string, unknown>;
    expect(payload.tags === undefined || Array.isArray(payload.tags)).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// tag_filter on artifact list and search routes
// ---------------------------------------------------------------------------

describe("GET / (artifact list) tag_filter", () => {
  it("returns 400 for an invalid tag grammar", async () => {
    const { app, mockEnv, mockExecutionCtx, doStub } = buildTestApp([
      new Response(JSON.stringify({ ok: true, artifacts: [] }), {
        status: 200,
      }),
    ]);

    const res = await app.fetch(
      new Request("http://localhost/?tag_filter=bad!tag"),
      mockEnv,
      mockExecutionCtx,
    );

    expect(res.status).toBe(400);
    expect(doStub.fetch).not.toHaveBeenCalled();
  });

  it("forwards valid tag_filter to the DO", async () => {
    const { app, mockEnv, mockExecutionCtx, doStub } = buildTestApp([
      new Response(JSON.stringify({ ok: true, artifacts: [] }), {
        status: 200,
      }),
    ]);

    const res = await app.fetch(
      new Request("http://localhost/?tag_filter=repo:a,team:x"),
      mockEnv,
      mockExecutionCtx,
    );

    expect(res.status).toBe(200);
    const forwardedReq = vi.mocked(doStub.fetch).mock.calls[0][0] as Request;
    const parsed = new URL(forwardedReq.url);
    expect(parsed.searchParams.get("tag_filter")).toBe("repo:a,team:x");
  });
});

describe("GET /search (artifact search) tag_filter", () => {
  it("returns 400 for an invalid tag grammar", async () => {
    const { app, mockEnv, mockExecutionCtx, doStub } = buildTestApp([
      new Response(JSON.stringify({ ok: true, results: [], total: 0 }), {
        status: 200,
      }),
    ]);

    const res = await app.fetch(
      new Request("http://localhost/search?q=hello&tag_filter=bad!tag"),
      mockEnv,
      mockExecutionCtx,
    );

    expect(res.status).toBe(400);
    expect(doStub.fetch).not.toHaveBeenCalled();
  });

  it("forwards valid tag_filter to the DO", async () => {
    const { app, mockEnv, mockExecutionCtx, doStub } = buildTestApp([
      new Response(JSON.stringify({ ok: true, results: [], total: 0 }), {
        status: 200,
      }),
    ]);

    const res = await app.fetch(
      new Request("http://localhost/search?q=hello&tag_filter=repo:a,team:x"),
      mockEnv,
      mockExecutionCtx,
    );

    expect(res.status).toBe(200);
    const forwardedReq = vi.mocked(doStub.fetch).mock.calls[0][0] as Request;
    const parsed = new URL(forwardedReq.url);
    expect(parsed.searchParams.get("tag_filter")).toBe("repo:a,team:x");
  });
});
