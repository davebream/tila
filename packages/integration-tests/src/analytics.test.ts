import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { emitRequestDatapoint } from "../../worker/src/lib/analytics";
import { forwardToDO } from "../../worker/src/lib/do-forward";

type TestBindings = { Bindings: { ANALYTICS: AnalyticsEngineDataset } };

describe("Analytics Engine integration", () => {
  describe("request datapoints via middleware", () => {
    it("emits a datapoint with route, method, status after a successful request", async () => {
      const mockWriteDataPoint = vi.fn();
      const mockWaitUntil = vi.fn();

      const app = new Hono<TestBindings>();

      // Wire analytics middleware matching the real app pattern
      app.use("*", async (c, next) => {
        const start = Date.now();
        await next();
        emitRequestDatapoint(
          c.env.ANALYTICS as unknown as AnalyticsEngineDataset,
          c.executionCtx,
          {
            route: c.req.routePath ?? c.req.path,
            method: c.req.method,
            projectId: "",
            latencyMs: Date.now() - start,
            statusCode: c.res.status,
          },
        );
      });

      app.get("/health", (c) => c.json({ status: "ok" }));

      const res = await app.fetch(
        new Request("http://localhost/health"),
        {
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
      expect(mockWriteDataPoint).toHaveBeenCalledOnce();

      const call = mockWriteDataPoint.mock.calls[0][0];
      expect(call.blobs[0]).toBe("/health"); // route pattern
      expect(call.blobs[1]).toBe("GET"); // method
      expect(call.blobs[3]).toBe("request"); // type discriminator
      expect(call.doubles[1]).toBe(200); // status code
      expect(call.doubles[0]).toBeGreaterThanOrEqual(0); // latency >= 0
      expect(call.indexes[0]).toBe("anonymous"); // no projectId
    });
  });

  describe("DO operation datapoints via forwardToDO", () => {
    it("emits a datapoint when analyticsCtx is provided", async () => {
      const mockWriteDataPoint = vi.fn();
      const mockWaitUntil = vi.fn();

      const mockStub = {
        fetch: vi.fn().mockResolvedValue(
          new Response(JSON.stringify({ ok: true, data: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        ),
      } as unknown as DurableObjectStub;

      const res = await forwardToDO(
        mockStub,
        "/entity/list",
        "GET",
        undefined,
        undefined,
        {
          analytics: {
            writeDataPoint: mockWriteDataPoint,
          } as unknown as AnalyticsEngineDataset,
          ctx: {
            waitUntil: mockWaitUntil,
            passThroughOnException: vi.fn(),
          } as unknown as ExecutionContext,
          projectId: "test-project",
        },
      );

      expect(res.status).toBe(200);
      expect(mockWriteDataPoint).toHaveBeenCalledOnce();

      const call = mockWriteDataPoint.mock.calls[0][0];
      expect(call.blobs[0]).toBe("entities"); // table derived from /entity/
      expect(call.blobs[1]).toBe("list"); // operation type
      expect(call.blobs[2]).toBe("test-project"); // projectId
      expect(call.blobs[3]).toBe("do_operation"); // type discriminator
      expect(call.doubles[0]).toBeGreaterThanOrEqual(0); // latency >= 0
      expect(call.doubles[1]).toBe(0); // rowsAffected = 0 in v0.1
      expect(call.indexes[0]).toBe("test-project");
    });
  });
});
