import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { Env, HonoVariables } from "../types";
import { emitDoOperationDatapoint, emitRequestDatapoint } from "./analytics";
import { forwardToDO } from "./do-forward";

function makeMockDataset() {
  return { writeDataPoint: vi.fn() } as unknown as AnalyticsEngineDataset;
}

function makeMockCtx() {
  return {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
  } as unknown as ExecutionContext;
}

describe("emitRequestDatapoint", () => {
  it("calls writeDataPoint with correct blobs, doubles, and indexes", () => {
    const dataset = makeMockDataset();
    const ctx = makeMockCtx();

    emitRequestDatapoint(dataset, ctx, {
      route: "/projects/:projectId/entities",
      method: "GET",
      projectId: "proj-1",
      latencyMs: 42,
      statusCode: 200,
    });

    expect(ctx.waitUntil).toHaveBeenCalledOnce();
    expect(dataset.writeDataPoint).toHaveBeenCalledWith({
      blobs: ["/projects/:projectId/entities", "GET", "proj-1", "request"],
      doubles: [42, 200],
      indexes: ["proj-1"],
    });
  });

  it("uses 'anonymous' index when projectId is empty", () => {
    const dataset = makeMockDataset();
    const ctx = makeMockCtx();

    emitRequestDatapoint(dataset, ctx, {
      route: "/health",
      method: "GET",
      projectId: "",
      latencyMs: 5,
      statusCode: 200,
    });

    expect(dataset.writeDataPoint).toHaveBeenCalledWith(
      expect.objectContaining({ indexes: ["anonymous"] }),
    );
  });

  it("swallows errors when writeDataPoint throws", () => {
    const dataset = {
      writeDataPoint: vi.fn(() => {
        throw new Error("AE down");
      }),
    } as unknown as AnalyticsEngineDataset;
    const ctx = makeMockCtx();

    // Must not throw
    emitRequestDatapoint(dataset, ctx, {
      route: "/test",
      method: "GET",
      projectId: "",
      latencyMs: 1,
      statusCode: 200,
    });
  });
});

describe("emitDoOperationDatapoint", () => {
  it("calls writeDataPoint with correct blobs, doubles, and indexes", () => {
    const dataset = makeMockDataset();
    const ctx = makeMockCtx();

    emitDoOperationDatapoint(dataset, ctx, {
      table: "entities",
      operationType: "create",
      latencyMs: 15,
      rowsAffected: 0,
      projectId: "proj-1",
    });

    expect(ctx.waitUntil).toHaveBeenCalledOnce();
    expect(dataset.writeDataPoint).toHaveBeenCalledWith({
      blobs: ["entities", "create", "proj-1", "do_operation"],
      doubles: [15, 0],
      indexes: ["proj-1"],
    });
  });

  it("swallows errors when writeDataPoint throws", () => {
    const dataset = {
      writeDataPoint: vi.fn(() => {
        throw new Error("AE down");
      }),
    } as unknown as AnalyticsEngineDataset;
    const ctx = makeMockCtx();

    emitDoOperationDatapoint(dataset, ctx, {
      table: "claims",
      operationType: "acquire",
      latencyMs: 10,
      rowsAffected: 0,
      projectId: "proj-1",
    });
  });
});

describe("analytics middleware (request datapoints)", () => {
  it("emits a request datapoint after a successful response", async () => {
    const mockWriteDataPoint = vi.fn();
    const mockWaitUntil = vi.fn();

    type AppEnv = { Bindings: Env; Variables: HonoVariables };
    const testApp = new Hono<AppEnv>();

    testApp.use("*", async (c, next) => {
      const start = Date.now();
      await next();
      emitRequestDatapoint(c.env.ANALYTICS, c.executionCtx, {
        route: c.req.routePath ?? c.req.path,
        method: c.req.method,
        projectId: c.get("projectId") ?? "",
        latencyMs: Date.now() - start,
        statusCode: c.res.status,
      });
    });

    testApp.get("/test", (c) => c.json({ ok: true }));

    const res = await testApp.fetch(
      new Request("http://localhost/test"),
      {
        DB: {} as D1Database,
        PROJECT: {} as DurableObjectNamespace,
        ARTIFACTS: {} as R2Bucket,
        ANALYTICS: {
          writeDataPoint: mockWriteDataPoint,
        } as unknown as AnalyticsEngineDataset,
      },
      {
        waitUntil: mockWaitUntil,
        passThroughOnException: vi.fn(),
      } as unknown as ExecutionContext,
    );

    expect(res.status).toBe(200);
    expect(mockWaitUntil).toHaveBeenCalled();
    expect(mockWriteDataPoint).toHaveBeenCalledWith(
      expect.objectContaining({
        blobs: expect.arrayContaining(["/test", "GET"]),
        doubles: expect.arrayContaining([200]),
      }),
    );
  });
});

describe("forwardToDO analytics emission", () => {
  it("emits a DO operation datapoint when analyticsCtx is provided", async () => {
    const mockWriteDataPoint = vi.fn();
    const mockWaitUntil = vi.fn();

    const mockStub = {
      fetch: vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ ok: true }), { status: 200 }),
        ),
    } as unknown as DurableObjectStub;

    await forwardToDO(
      mockStub,
      "/entity/create",
      "POST",
      { kind: "test" },
      undefined,
      {
        analytics: {
          writeDataPoint: mockWriteDataPoint,
        } as unknown as AnalyticsEngineDataset,
        ctx: {
          waitUntil: mockWaitUntil,
          passThroughOnException: vi.fn(),
        } as unknown as ExecutionContext,
        projectId: "proj-1",
      },
    );

    expect(mockStub.fetch).toHaveBeenCalledOnce();
    expect(mockWaitUntil).toHaveBeenCalled();
    expect(mockWriteDataPoint).toHaveBeenCalledWith(
      expect.objectContaining({
        blobs: ["entities", "create", "proj-1", "do_operation"],
        doubles: expect.arrayContaining([0]), // rowsAffected = 0
      }),
    );
  });

  it("does not emit when analyticsCtx is omitted (backward compatible)", async () => {
    const mockStub = {
      fetch: vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ ok: true }), { status: 200 }),
        ),
    } as unknown as DurableObjectStub;

    // No analyticsCtx -- existing call pattern
    const res = await forwardToDO(mockStub, "/entity/list", "GET");
    expect(res.status).toBe(200);
    // No crash, no writeDataPoint call
  });

  it("still emits analytics when stub.fetch throws", async () => {
    const mockWriteDataPoint = vi.fn();
    const mockWaitUntil = vi.fn();

    const mockStub = {
      fetch: vi.fn().mockRejectedValue(new Error("DO unavailable")),
    } as unknown as DurableObjectStub;

    await expect(
      forwardToDO(mockStub, "/claim/acquire", "POST", {}, undefined, {
        analytics: {
          writeDataPoint: mockWriteDataPoint,
        } as unknown as AnalyticsEngineDataset,
        ctx: {
          waitUntil: mockWaitUntil,
          passThroughOnException: vi.fn(),
        } as unknown as ExecutionContext,
        projectId: "proj-1",
      }),
    ).rejects.toThrow("DO unavailable");

    // Analytics should still fire from the finally block
    expect(mockWaitUntil).toHaveBeenCalled();
    expect(mockWriteDataPoint).toHaveBeenCalledWith(
      expect.objectContaining({
        blobs: ["claims", "acquire", "proj-1", "do_operation"],
      }),
    );
  });
});
