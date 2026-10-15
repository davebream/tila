import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { queueRoutes } from "../src/routes/queue";
import type { Env, HonoVariables } from "../src/types";

type AppEnv = { Bindings: Env; Variables: HonoVariables };

const result = { ok: true, result: { entries: [] } };
const forwarded: Array<{ path: string; body: Record<string, unknown> }> = [];
const stub = {
  fetch: vi.fn(async (request: Request) => {
    forwarded.push({
      path: new URL(request.url).pathname,
      body: (await request.json()) as Record<string, unknown>,
    });
    return Response.json(result);
  }),
} as unknown as DurableObjectStub;

function app() {
  const root = new Hono<AppEnv>();
  root.use("*", async (c, next) => {
    c.set("doStub", stub);
    c.set("authorizationChecked", true);
    c.set("principalId", "principal");
    c.set("projectId", "project");
    c.set("effectiveRole", "viewer");
    await next();
  });
  root.route("/queue", queueRoutes);
  return root;
}
const env = { ANALYTICS: { writeDataPoint: vi.fn() } } as unknown as Env;
const ctx = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
} as unknown as ExecutionContext;
const get = (search: string) => app().request(`/queue${search}`, {}, env, ctx);
const command = () => forwarded.at(-1)?.body.command as Record<string, unknown>;

beforeEach(() => {
  forwarded.length = 0;
});

describe("GET /queue compact parameter", () => {
  it("leaves compact false when absent, so the listing is the full one", async () => {
    expect((await get("")).status).toBe(200);
    expect(forwarded.at(-1)?.path).toBe("/queue/inspect");
    expect(command().compact).toBe(false);
  });

  it("treats the literal false as false, never as a truthy string", async () => {
    expect((await get("?compact=false")).status).toBe(200);
    expect(command().compact).toBe(false);
  });

  it("treats the literal true as true", async () => {
    expect((await get("?compact=true&limit=5")).status).toBe(200);
    expect(command()).toMatchObject({ compact: true, limit: 5 });
  });

  it.each(["1", "0", "yes", "no", "TRUE", "False", "", "null"])(
    "rejects compact=%j instead of guessing",
    async (value) => {
      const response = await get(`?compact=${value}`);
      expect(response.status).toBe(400);
      const body = (await response.json()) as {
        ok: boolean;
        error: { code: string; message: string };
      };
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe("validation-error");
      expect(body.error.message).toContain("compact");
      expect(forwarded).toHaveLength(0);
    },
  );

  it("does not forward compact for other query families", async () => {
    const response = await app().request(
      "/queue/policy?compact=true",
      {},
      env,
      ctx,
    );
    expect(response.status).toBe(200);
    expect(forwarded.at(-1)?.body.command).toEqual({});
  });
});
