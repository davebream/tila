import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env, HonoVariables } from "../types";

const forwardToDOMock = vi.fn();

vi.mock("../lib/do-forward", () => ({
  forwardToDO: (...args: unknown[]) => forwardToDOMock(...args),
}));

const { doctor } = await import("./doctor");

type AppEnv = { Bindings: Env; Variables: HonoVariables };

function createApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("doStub", {} as DurableObjectStub);
    c.set("tokenResult", {
      kind: "d1-token",
      projectId: "test",
      name: "test",
      scopes: "full",
      tokenId: "test",
    });
    await next();
  });
  app.route("/", doctor);
  return app;
}

describe("doctor schema route", () => {
  beforeEach(() => {
    forwardToDOMock.mockReset();
  });

  it("returns the DO schema diagnostic when available", async () => {
    forwardToDOMock.mockResolvedValueOnce(
      Response.json({
        ok: true,
        sqlite_version: "3.47.0",
        migrations: [{ version: 1, applied_at: 123 }],
        tables: ["claims"],
        columns: { claims: [] },
      }),
    );

    const res = await createApp().request("/doctor/schema");

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      sqlite_version: "3.47.0",
    });
    expect(forwardToDOMock).toHaveBeenCalledWith(
      expect.anything(),
      "/doctor/schema",
      "GET",
    );
  });

  it("returns a stale-DO diagnostic fallback when the DO route is missing", async () => {
    forwardToDOMock
      .mockResolvedValueOnce(Response.json({ ok: false }, { status: 404 }))
      .mockResolvedValueOnce(
        Response.json({
          ok: false,
          error: {
            code: "internal",
            message: "Internal server error",
            retryable: true,
          },
        }),
      );

    const res = await createApp().request("/doctor/schema");

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      stale_do: boolean;
      probe_result: unknown;
    };
    expect(body.ok).toBe(true);
    expect(body.stale_do).toBe(true);
    expect(body.probe_result).toMatchObject({
      ok: false,
      error: { code: "internal" },
    });
    expect(forwardToDOMock).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      "/coord/acquire",
      "POST",
      expect.objectContaining({
        resource: "__probe__schema__",
      }),
    );
  });

  it("releases the schema probe claim when fallback acquire succeeds", async () => {
    forwardToDOMock
      .mockResolvedValueOnce(Response.json({ ok: false }, { status: 404 }))
      .mockResolvedValueOnce(Response.json({ ok: true, fence: 42 }))
      .mockResolvedValueOnce(Response.json({ ok: true }));

    const res = await createApp().request("/doctor/schema");

    expect(res.status).toBe(200);
    expect(forwardToDOMock).toHaveBeenNthCalledWith(
      3,
      expect.anything(),
      "/coord/release",
      "POST",
      {
        resource: "__probe__schema__",
        fence: 42,
        actor: "__probe__/__probe__",
      },
    );
  });
});
