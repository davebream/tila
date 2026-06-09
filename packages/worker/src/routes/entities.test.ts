/**
 * Route-level tests for the entity relationship list/delete routes (#399).
 *
 * Verifies query-param parsing, DO forwarding, success status codes, Zod
 * validation, and the requirePermission guards (read for list, write for delete).
 * The realistic scoped-token end-to-end flow is exercised in the integration tests.
 */
import type { IdempotencyStoreLike } from "@tila/backend-d1";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createIdempotencyMiddleware } from "../middleware/idempotency";
import type { Env, HonoVariables } from "../types";
import { entities } from "./entities";

type AppEnv = { Bindings: Env; Variables: HonoVariables };

function jsonResponse(body: object, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Minimal env + execution context so analyticsCtxFrom() can read c.env.ANALYTICS.
const MOCK_ENV = {
  ANALYTICS: { writeDataPoint: () => {} },
} as unknown as Env;
const MOCK_CTX = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

function mockStub(response: Response): DurableObjectStub {
  return {
    fetch: vi.fn(async () => response),
  } as unknown as DurableObjectStub;
}

const FULL_TOKEN = {
  kind: "d1-token" as const,
  name: "test-agent",
  tokenId: "tok_123",
  scopes: "full",
};

const READ_SESSION = {
  kind: "session" as const,
  name: "reader",
  tokenId: "tok_read",
  permission: "read",
};

function createApp(
  stub: DurableObjectStub,
  tokenResult: HonoVariables["tokenResult"],
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("doStub", stub);
    c.set("tokenResult", tokenResult);
    c.set("source", "cli");
    c.set("sourceVersion", "test");
    await next();
  });
  app.route("/", entities);
  return app;
}

describe("GET /relationships", () => {
  it("forwards filters to the DO and returns the relationship list", async () => {
    const rels = [
      {
        from_id: "A",
        to_id: "B",
        type: "blocks",
        schema_version: 1,
        created_at: 1,
      },
    ];
    const stub = mockStub(jsonResponse({ ok: true, relationships: rels }));
    const app = createApp(stub, FULL_TOKEN as never);

    const res = await app.request(
      "/relationships?from_id=A&type=blocks",
      undefined,
      MOCK_ENV,
      MOCK_CTX,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      relationships: unknown[];
    };
    expect(body.ok).toBe(true);
    expect(body.relationships).toHaveLength(1);
    // Forwarded to the DO list route with the filters as query params.
    const forwardedUrl = vi.mocked(stub.fetch).mock.calls[0][0] as
      | Request
      | string;
    const url =
      typeof forwardedUrl === "string" ? forwardedUrl : forwardedUrl.url;
    expect(url).toContain("/entity/relationship/list");
    expect(url).toContain("from_id=A");
    expect(url).toContain("type=blocks");
  });

  it("rejects an invalid relationship type with 400 and does not call the DO", async () => {
    const stub = mockStub(jsonResponse({ ok: true, relationships: [] }));
    const app = createApp(stub, FULL_TOKEN as never);

    const res = await app.request(
      "/relationships?type=not-a-real-type",
      undefined,
      MOCK_ENV,
      MOCK_CTX,
    );

    expect(res.status).toBe(400);
    expect(stub.fetch).not.toHaveBeenCalled();
  });

  it("allows a read-scoped session token (read permission)", async () => {
    const stub = mockStub(jsonResponse({ ok: true, relationships: [] }));
    const app = createApp(stub, READ_SESSION as never);

    const res = await app.request(
      "/relationships",
      undefined,
      MOCK_ENV,
      MOCK_CTX,
    );

    expect(res.status).toBe(200);
  });
});

describe("DELETE /relationships", () => {
  it("forwards the composite key to the DO and returns 200 with removed", async () => {
    const stub = mockStub(jsonResponse({ ok: true, removed: true }));
    const app = createApp(stub, FULL_TOKEN as never);

    const res = await app.request(
      "/relationships?from_id=A&to_id=B&type=blocks",
      { method: "DELETE" },
      MOCK_ENV,
      MOCK_CTX,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; removed: boolean };
    expect(body.ok).toBe(true);
    expect(body.removed).toBe(true);
    const forwardedUrl = vi.mocked(stub.fetch).mock.calls[0][0] as
      | Request
      | string;
    const url =
      typeof forwardedUrl === "string" ? forwardedUrl : forwardedUrl.url;
    expect(url).toContain("/entity/relationship/delete");
  });

  it("rejects a read-scoped session token with 403 (write required)", async () => {
    const stub = mockStub(jsonResponse({ ok: true, removed: false }));
    const app = createApp(stub, READ_SESSION as never);

    const res = await app.request(
      "/relationships?from_id=A&to_id=B&type=blocks",
      { method: "DELETE" },
      MOCK_ENV,
      MOCK_CTX,
    );

    expect(res.status).toBe(403);
    expect(stub.fetch).not.toHaveBeenCalled();
  });

  it("rejects a missing composite key with 400", async () => {
    const stub = mockStub(jsonResponse({ ok: true, removed: false }));
    const app = createApp(stub, FULL_TOKEN as never);

    const res = await app.request(
      "/relationships?from_id=A",
      { method: "DELETE" },
      MOCK_ENV,
      MOCK_CTX,
    );

    expect(res.status).toBe(400);
    expect(stub.fetch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Idempotency middleware wiring tests
// ---------------------------------------------------------------------------

type StoredEntry = {
  statusCode: number;
  body: string;
  requestHash: string | null;
};

class FakeIdempotencyStore implements IdempotencyStoreLike {
  private map = new Map<string, StoredEntry>();

  async check(
    key: string,
    _projectId: string,
  ): Promise<{
    statusCode: number;
    body: string;
    requestHash: string | null;
  } | null> {
    return this.map.get(key) ?? null;
  }

  async store(
    key: string,
    _projectId: string,
    statusCode: number,
    responseJson: string,
    requestHash?: string | null,
  ): Promise<void> {
    if (!this.map.has(key)) {
      this.map.set(key, {
        statusCode,
        body: responseJson,
        requestHash: requestHash ?? null,
      });
    }
  }
}

/** Canned create response the DO stub returns */
const CANNED_CREATE_RESPONSE = {
  ok: true,
  entity: { id: "ent_001", type: "task", status: "open" },
};

function createWiringApp(
  stub: DurableObjectStub,
  fake: IdempotencyStoreLike,
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  // stub middleware: sets projectId, tokenResult, source (required by entities handler)
  app.use("*", async (c, next) => {
    c.set("doStub", stub);
    c.set("tokenResult", FULL_TOKEN as never);
    c.set("source", "cli");
    c.set("sourceVersion", "test");
    c.set("projectId", "proj_wiring");
    await next();
  });
  // idempotency middleware with injected in-memory store
  app.use("/*", createIdempotencyMiddleware({ makeStore: () => fake }));
  // mount entities routes
  app.route("/", entities);
  return app;
}

describe("Idempotency middleware wiring (entities route)", () => {
  it("same Idempotency-Key + body: DO called once, second response has Idempotency-Replayed: true", async () => {
    const stub = {
      fetch: vi.fn(async () => jsonResponse(CANNED_CREATE_RESPONSE)),
    } as unknown as DurableObjectStub;
    const fake = new FakeIdempotencyStore();
    const app = createWiringApp(stub, fake);

    const reqBody = JSON.stringify({
      id: "ent_001",
      type: "task",
      data: { title: "My task" },
    });
    const headers = {
      "Content-Type": "application/json",
      "Idempotency-Key": "wiring-key-001",
    };

    // First request: goes to DO
    const res1 = await app.request(
      "/",
      { method: "POST", headers, body: reqBody },
      MOCK_ENV,
      MOCK_CTX,
    );
    expect(res1.status).toBe(200);

    // Second identical request: replayed from store, DO NOT called again
    const res2 = await app.request(
      "/",
      { method: "POST", headers, body: reqBody },
      MOCK_ENV,
      MOCK_CTX,
    );
    expect(res2.status).toBe(200);
    expect(res2.headers.get("Idempotency-Replayed")).toBe("true");

    // DO fetch called exactly once (not twice)
    expect(vi.mocked(stub.fetch).mock.calls.length).toBe(1);
  });

  it("no Idempotency-Key: DO called twice (middleware inactive, behavior unchanged)", async () => {
    const stub = {
      fetch: vi.fn(async () => jsonResponse(CANNED_CREATE_RESPONSE)),
    } as unknown as DurableObjectStub;
    const fake = new FakeIdempotencyStore();
    const app = createWiringApp(stub, fake);

    const reqBody = JSON.stringify({
      id: "ent_002",
      type: "task",
      data: { title: "Another task" },
    });
    const headers = {
      "Content-Type": "application/json",
      // no Idempotency-Key header
    };

    await app.request(
      "/",
      { method: "POST", headers, body: reqBody },
      MOCK_ENV,
      MOCK_CTX,
    );
    await app.request(
      "/",
      { method: "POST", headers, body: reqBody },
      MOCK_ENV,
      MOCK_CTX,
    );

    // DO fetch called twice (idempotency middleware inactive without the header)
    expect(vi.mocked(stub.fetch).mock.calls.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// tag_filter on entity list route
// ---------------------------------------------------------------------------

describe("GET / (entity list) tag_filter", () => {
  it("returns 400 for an invalid tag grammar", async () => {
    const stub = mockStub(jsonResponse({ ok: true, entities: [] }));
    const app = createApp(stub, FULL_TOKEN as never);

    const res = await app.request(
      "/?tag_filter=bad!tag",
      undefined,
      MOCK_ENV,
      MOCK_CTX,
    );

    expect(res.status).toBe(400);
    expect(stub.fetch).not.toHaveBeenCalled();
  });

  it("forwards valid tag_filter comma-joined to the DO", async () => {
    const stub = mockStub(jsonResponse({ ok: true, entities: [] }));
    const app = createApp(stub, FULL_TOKEN as never);

    const res = await app.request(
      "/?tag_filter=repo:a,team:x",
      undefined,
      MOCK_ENV,
      MOCK_CTX,
    );

    expect(res.status).toBe(200);
    const forwardedReq = vi.mocked(stub.fetch).mock.calls[0][0] as
      | Request
      | string;
    const forwardedUrl =
      typeof forwardedReq === "string" ? forwardedReq : forwardedReq.url;
    const parsed = new URL(forwardedUrl);
    expect(parsed.searchParams.get("tag_filter")).toBe("repo:a,team:x");
  });
});
