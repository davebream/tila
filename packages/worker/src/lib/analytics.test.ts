import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { Env, HonoVariables } from "../types";
import {
  emitDoOperationDatapoint,
  emitRequestDatapoint,
  emitSweepErrorDatapoint,
  emitSweepProjectDatapoint,
  emitSweepRollupDatapoint,
} from "./analytics";
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

// ---------------------------------------------------------------------------
// Sweep emitters (Task 9 / PR17). These cover the analytics===undefined
// early-return and ctx===undefined inline-write branches directly, which the
// sweep integration tests only exercise indirectly.
// ---------------------------------------------------------------------------

describe("emitSweepProjectDatapoint", () => {
  const fields = {
    projectId: "proj-1",
    status: "ok",
    sweep: "ok",
    archive: "ok",
    drift: "ok",
    expired: 3,
    remaining: 0,
    truncated: false,
  };

  it("writes inline (no waitUntil) when ctx is undefined", () => {
    const dataset = makeMockDataset();

    emitSweepProjectDatapoint(dataset, undefined, fields);

    expect(dataset.writeDataPoint).toHaveBeenCalledWith({
      blobs: ["proj-1", "ok", "ok", "ok", "ok", "sweep_project"],
      doubles: [3, 0, 0],
      indexes: ["proj-1"],
    });
  });

  it("routes through ctx.waitUntil when ctx is provided", () => {
    const dataset = makeMockDataset();
    const ctx = makeMockCtx();

    emitSweepProjectDatapoint(dataset, ctx, fields);

    expect(ctx.waitUntil).toHaveBeenCalledOnce();
    expect(dataset.writeDataPoint).toHaveBeenCalledOnce();
  });

  it("encodes truncated=true as a 1 in doubles and falls back to 'unknown' index for empty projectId", () => {
    const dataset = makeMockDataset();

    emitSweepProjectDatapoint(dataset, undefined, {
      ...fields,
      projectId: "",
      truncated: true,
    });

    expect(dataset.writeDataPoint).toHaveBeenCalledWith(
      expect.objectContaining({
        doubles: [3, 0, 1],
        indexes: ["unknown"],
      }),
    );
  });

  it("is a no-op when analytics is undefined", () => {
    // Must not throw — the seam (and Free plans without an AE dataset) pass
    // undefined. There is nothing to assert beyond "does not throw".
    expect(() =>
      emitSweepProjectDatapoint(undefined, undefined, fields),
    ).not.toThrow();
  });

  it("swallows errors when writeDataPoint throws", () => {
    const dataset = {
      writeDataPoint: vi.fn(() => {
        throw new Error("AE down");
      }),
    } as unknown as AnalyticsEngineDataset;

    expect(() =>
      emitSweepProjectDatapoint(dataset, undefined, fields),
    ).not.toThrow();
  });
});

describe("emitSweepErrorDatapoint", () => {
  it("writes inline (no waitUntil) when ctx is undefined", () => {
    const dataset = makeMockDataset();

    emitSweepErrorDatapoint(dataset, undefined, { phase: "pre-loop" });

    expect(dataset.writeDataPoint).toHaveBeenCalledWith({
      blobs: ["pre-loop", "sweep_error"],
      doubles: [1],
      indexes: ["sweep"],
    });
  });

  it("routes through ctx.waitUntil when ctx is provided", () => {
    const dataset = makeMockDataset();
    const ctx = makeMockCtx();

    emitSweepErrorDatapoint(dataset, ctx, { phase: "pre-loop" });

    expect(ctx.waitUntil).toHaveBeenCalledOnce();
  });

  it("is a no-op when analytics is undefined", () => {
    expect(() =>
      emitSweepErrorDatapoint(undefined, undefined, { phase: "pre-loop" }),
    ).not.toThrow();
  });

  it("swallows errors when writeDataPoint throws", () => {
    const dataset = {
      writeDataPoint: vi.fn(() => {
        throw new Error("AE down");
      }),
    } as unknown as AnalyticsEngineDataset;

    expect(() =>
      emitSweepErrorDatapoint(dataset, undefined, { phase: "pre-loop" }),
    ).not.toThrow();
  });
});

describe("emitSweepRollupDatapoint", () => {
  const fields = {
    projectsSwept: 5,
    projectsDegraded: 2,
    artifactsExpired: 40,
    journalEventsArchived: 10,
    driftReconciled: 1,
    projectsEmitted: 7,
    truncated: false,
  };

  it("writes inline (no waitUntil) when ctx is undefined, indexed under 'sweep'", () => {
    const dataset = makeMockDataset();

    emitSweepRollupDatapoint(dataset, undefined, fields);

    expect(dataset.writeDataPoint).toHaveBeenCalledWith({
      blobs: ["complete", "sweep_rollup"],
      doubles: [5, 2, 40, 10, 1, 7],
      indexes: ["sweep"],
    });
  });

  it("tags the rollup 'truncated' when the run hit a resume point", () => {
    const dataset = makeMockDataset();

    emitSweepRollupDatapoint(dataset, undefined, {
      ...fields,
      truncated: true,
    });

    expect(dataset.writeDataPoint).toHaveBeenCalledWith(
      expect.objectContaining({ blobs: ["truncated", "sweep_rollup"] }),
    );
  });

  it("routes through ctx.waitUntil when ctx is provided", () => {
    const dataset = makeMockDataset();
    const ctx = makeMockCtx();

    emitSweepRollupDatapoint(dataset, ctx, fields);

    expect(ctx.waitUntil).toHaveBeenCalledOnce();
  });

  it("is a no-op when analytics is undefined", () => {
    expect(() =>
      emitSweepRollupDatapoint(undefined, undefined, fields),
    ).not.toThrow();
  });

  it("swallows errors when writeDataPoint throws", () => {
    const dataset = {
      writeDataPoint: vi.fn(() => {
        throw new Error("AE down");
      }),
    } as unknown as AnalyticsEngineDataset;

    expect(() =>
      emitSweepRollupDatapoint(dataset, undefined, fields),
    ).not.toThrow();
  });
});
