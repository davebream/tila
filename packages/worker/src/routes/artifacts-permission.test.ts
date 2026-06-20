/**
 * Route-level permission tests for the artifacts route.
 *
 * Issue #445 added requirePermission guards to six artifact routes:
 * - POST /artifacts/relationship          → write guard
 * - GET  /artifacts/                       → read guard
 * - GET  /artifacts/latest                 → read guard
 * - GET  /artifacts/index/entries          → read guard (regex-param route before catch-all)
 * - GET  /artifacts/:key/relationships     → read guard (regex-param route before catch-all)
 * - GET  /artifacts/:key (blob catch-all)  → read guard
 *
 * The guard is a single shared middleware, so these tests exercise it across the
 * read/write guard classes and across the ordering-sensitive regex-param and
 * catch-all routes, rather than re-testing every individual read route.
 */
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { CookieSessionTokenResult, Env, HonoVariables } from "../types";
import { artifacts } from "./artifacts";

type AppEnv = { Bindings: Env; Variables: HonoVariables };

const MOCK_ENV = {
  ANALYTICS: { writeDataPoint: () => {} },
} as unknown as Env;
const MOCK_CTX = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

// Returns a fresh Response per invocation — POST /relationship reads the stub
// twice (a GET /schema/current fetch then the relationship forward); reusing a
// single Response instance throws "Body already used" on the second read.
function mockStub(
  status = 200,
  body: unknown = { ok: false },
): DurableObjectStub {
  return {
    fetch: vi.fn(async () => new Response(JSON.stringify(body), { status })),
  } as unknown as DurableObjectStub;
}

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
    return next();
  });
  app.route("/artifacts", artifacts);
  return app;
}

function readCookieSession(): CookieSessionTokenResult {
  return {
    kind: "cookie-session" as const,
    projectId: "proj-1",
    name: "gh-reader",
    scopes: "read",
    tokenId: "",
    sessionHash: "cs-hash",
    expiresAt: Date.now() + 3600_000,
    permission: "read",
  };
}

function fullCookieSession(): CookieSessionTokenResult {
  return {
    ...readCookieSession(),
    name: "gh-admin",
    scopes: "full",
    permission: "admin",
  };
}

describe("artifacts route permission guards", () => {
  it("rejects read-scope cookie-session on POST /artifacts/relationship with 403", async () => {
    const app = createApp(mockStub(), readCookieSession());
    const res = await app.fetch(
      new Request("http://localhost/artifacts/relationship", {
        method: "POST",
        body: JSON.stringify({ from_key: "a", to_key: "b", type: "rel" }),
        headers: { "content-type": "application/json" },
      }),
      MOCK_ENV,
      MOCK_CTX,
    );
    expect(res.status).toBe(403);
  });

  it("allows read-scope cookie-session on GET /artifacts/ with 200", async () => {
    const app = createApp(
      mockStub(200, { ok: true, artifacts: [] }),
      readCookieSession(),
    );
    const res = await app.fetch(
      new Request("http://localhost/artifacts"),
      MOCK_ENV,
      MOCK_CTX,
    );
    expect(res.status).toBe(200);
  });

  it("allows read-scope cookie-session on GET /artifacts/index/entries with 200", async () => {
    const app = createApp(
      mockStub(200, { ok: true, entries: [] }),
      readCookieSession(),
    );
    const res = await app.fetch(
      new Request("http://localhost/artifacts/index/entries?index_key=foo"),
      MOCK_ENV,
      MOCK_CTX,
    );
    expect(res.status).toBe(200);
  });

  it("allows read-scope cookie-session on GET /artifacts/:key blob catch-all with 200", async () => {
    // The blob catch-all returns the DO inline fast-path (200) before hitting R2;
    // this pins the read guard on the ordering-sensitive /:key{.+$} route.
    const app = createApp(
      mockStub(200, {
        ok: true,
        pointer: { content_inline: "hello", mime_type: "text/plain" },
      }),
      readCookieSession(),
    );
    const res = await app.fetch(
      new Request("http://localhost/artifacts/sources/abc123.md"),
      MOCK_ENV,
      MOCK_CTX,
    );
    expect(res.status).toBe(200);
  });

  it("allows full-scope cookie-session on GET /artifacts/ with 200", async () => {
    const app = createApp(
      mockStub(200, { ok: true, artifacts: [] }),
      fullCookieSession(),
    );
    const res = await app.fetch(
      new Request("http://localhost/artifacts"),
      MOCK_ENV,
      MOCK_CTX,
    );
    expect(res.status).toBe(200);
  });

  it("allows full-scope cookie-session on POST /artifacts/relationship (not 403)", async () => {
    const app = createApp(mockStub(), fullCookieSession());
    const res = await app.fetch(
      new Request("http://localhost/artifacts/relationship", {
        method: "POST",
        body: JSON.stringify({ from_key: "a", to_key: "b", type: "rel" }),
        headers: { "content-type": "application/json" },
      }),
      MOCK_ENV,
      MOCK_CTX,
    );
    expect(res.status).not.toBe(403);
  });
});
