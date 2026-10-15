/**
 * Worker route contract for GET /records/:type/:key and its `?meta=1` form.
 *
 * The route validates the query itself and forwards exactly one DO read: the
 * ordinary read forwards no query at all (so its request is unchanged), the
 * metadata read forwards `meta=1`, and an invalid `meta` is answered 400 before
 * any DO call is made.
 */
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { Env, HonoVariables } from "../types";
import { records } from "./records";

type AppEnv = { Bindings: Env; Variables: HonoVariables };

const MOCK_ENV = {
  ANALYTICS: { writeDataPoint: () => {} },
} as unknown as Env;
const MOCK_CTX = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

const META = {
  type: "answer",
  key: "a1/x",
  revision: 3,
  fence: 3,
  value_sha256: "a".repeat(64),
  updated_at: 1700000000000,
  archived: 0,
};

function setup() {
  const fetch = vi.fn(async (req: Request | string) => {
    const url = new URL(typeof req === "string" ? req : req.url);
    return new Response(
      JSON.stringify(
        url.searchParams.get("meta") === "1"
          ? { ok: true, meta: META }
          : { ok: true, record: { type: "answer", key: "a1/x" }, fence: 3 },
      ),
      { headers: { "Content-Type": "application/json" } },
    );
  });
  const stub = { fetch } as unknown as DurableObjectStub;
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("doStub", stub);
    c.set("projectId", "proj-meta");
    c.set("tokenResult", {
      kind: "d1-token",
      projectId: "proj-meta",
      name: "agent",
      tokenId: "tok_1",
      scopes: "full",
    } as never);
    c.set("principalId", "token:tok_1");
    c.set("participantId", "participant");
    c.set("environment", {});
    await next();
  });
  app.route("/", records);
  const request = (path: string) =>
    app.request(path, undefined, MOCK_ENV, MOCK_CTX);
  const forwarded = () =>
    fetch.mock.calls.map(([req]) => {
      const url = new URL(typeof req === "string" ? req : req.url);
      return `${url.pathname}${url.search}`;
    });
  return { request, forwarded };
}

describe("GET /records/:type/:key", () => {
  it("forwards the ordinary read with no query and returns the full record", async () => {
    const { request, forwarded } = setup();

    const res = await request("/answer/a1/x");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      record: { type: "answer", key: "a1/x" },
      fence: 3,
    });
    expect(forwarded()).toEqual(["/record/answer/a1/x"]);
  });

  it("forwards unrelated query parameters as nothing, as before", async () => {
    const { request, forwarded } = setup();

    await request("/answer/a1/x?cache=bust");

    expect(forwarded()).toEqual(["/record/answer/a1/x"]);
  });

  it("forwards meta=1 to the same DO path and returns the metadata response", async () => {
    const { request, forwarded } = setup();

    const res = await request("/answer/a1/x?meta=1");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, meta: META });
    expect(forwarded()).toEqual(["/record/answer/a1/x?meta=1"]);
  });

  it("keeps slash keys intact in the forwarded path", async () => {
    const { request, forwarded } = setup();

    await request("/answer/a1/deep/er/key?meta=1");

    expect(forwarded()).toEqual(["/record/answer/a1/deep/er/key?meta=1"]);
  });

  it.each([
    "meta=true",
    "meta=0",
    "meta=false",
    "meta=",
    "meta=yes",
    "meta=01",
    "meta=1&meta=1",
    "meta=1&meta=0",
  ])("answers 400 validation-error for %s and makes no DO call", async (q) => {
    const { request, forwarded } = setup();

    const res = await request(`/answer/a1/x?${q}`);
    const body = (await res.json()) as {
      ok: boolean;
      error: { code: string; retryable: boolean };
    };

    expect(res.status).toBe(400);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("validation-error");
    expect(body.error.retryable).toBe(false);
    expect(forwarded()).toEqual([]);
  });
});
