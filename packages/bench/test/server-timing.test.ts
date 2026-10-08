import { afterEach, describe, expect, it, vi } from "vitest";
import { createHttpDriver } from "../src/drivers/http";
import { timed } from "../src/measure";
import { Recorder } from "../src/recorder";
import { probeRegion } from "../src/region";
import { renderScenario } from "../src/report";
import { MetricsSchema } from "../src/result-schema";
import {
  TIMING_NAMES,
  captureHttpTiming,
  parseServerTiming,
} from "../src/server-timing";

afterEach(() => vi.restoreAllMocks());
const header = (worker = 10) =>
  TIMING_NAMES.map(
    (name) =>
      `tila_${name};dur=${name === "worker" || name === "auth_token" ? worker : 0}`,
  ).join(", ");

describe("HTTP attribution", () => {
  it("accepts complete timing and rejects partial, duplicate, inconsistent or malformed values", () => {
    expect(parseServerTiming(`vendor;dur=1, ${header()}`)?.worker).toBe(10);
    for (const value of [
      null,
      "tila_worker;dur=2",
      `${header()}, tila_worker;dur=1`,
      header().replace("dur=10", "dur=-1"),
      header().replace("dur=10", "dur=Infinity"),
      header().replace("dur=10", "dur=11"),
    ]) {
      expect(parseServerTiming(value)).toBeUndefined();
    }
  });

  it("keeps simultaneous successful and failed facade calls isolated without consuming bodies", async () => {
    const [a, b] = await Promise.all([
      timed("a", async () => {
        await Promise.resolve();
        const response = Response.json(
          { ok: true },
          { headers: { "Server-Timing": header(1) } },
        );
        captureHttpTiming(response);
        return response.json();
      }),
      timed("b", async () => {
        captureHttpTiming(
          new Response(null, {
            status: 500,
            headers: { "Server-Timing": header(2) },
          }),
        );
        throw new Error("failure");
      }),
    ]);
    expect(a.value).toEqual({ ok: true });
    expect(a.httpTimings?.map((s) => s.server?.worker)).toEqual([1]);
    expect(b.cls).toBe("error");
    expect(b.httpTimings?.map((s) => s.server?.worker)).toEqual([2]);
  });

  it("excludes warmup starts and calculates residuals per matched sample", () => {
    vi.spyOn(performance, "now").mockReturnValue(100);
    const recorder = new Recorder();
    const outcome = {
      op: "acquire",
      cls: "ok" as const,
      latencyMs: 30,
      startedAt: 101,
      httpTimings: [{ server: parseServerTiming(header(10)) }],
    };
    recorder.record(outcome); // setup
    recorder.start();
    recorder.record({ ...outcome, startedAt: 99 }); // crossed warmup boundary
    recorder.record(outcome);
    recorder.record({
      ...outcome,
      latencyMs: 50,
      httpTimings: [{ server: parseServerTiming(header(40)) }],
    });
    recorder.record({ ...outcome, httpTimings: [{}] }); // old deployment
    recorder.stop();
    recorder.record(outcome); // teardown
    const metrics = recorder.snapshot().totals;
    expect(metrics.ops).toBe(3);
    expect(metrics.timing?.timed_requests).toBe(2);
    expect(metrics.timing?.requests).toBe(3);
    expect(metrics.timing?.metrics.transport_client).toMatchObject({
      count: 2,
      mean: 15,
    });
    expect(metrics.timing?.metrics.worker).toMatchObject({
      count: 2,
      mean: 25,
    });
    expect(MetricsSchema.parse(metrics).timing).toEqual(metrics.timing);
    const { timing: _, ...old } = metrics;
    expect(MetricsSchema.parse(old).timing).toBeUndefined();
  });

  it("reports negative residuals and does not invent a facade residual for multiple requests", () => {
    const rec = new Recorder();
    rec.start();
    const sample = { server: parseServerTiming(header(10)) };
    rec.record({ op: "read", cls: "ok", latencyMs: 5, httpTimings: [sample] });
    rec.record({
      op: "read",
      cls: "ok",
      latencyMs: 30,
      httpTimings: [sample, sample],
    });
    const timing = rec.snapshot().totals.timing;
    expect(timing?.invalid_residuals).toBe(1);
    expect(timing?.metrics.transport_client).toBeUndefined();
    expect(timing?.metrics.worker.count).toBe(3);
  });

  it("captures real SDK transport headers and prefers measured placement over the health probe", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === "/api/health")
        return Response.json({}, { headers: { "cf-ray": "probe-WAW" } });
      if (path === "/api/whoami")
        return Response.json({ principal_id: "test" });
      return Response.json(
        { claims: [] },
        {
          headers: {
            "Server-Timing": header(0),
            "cf-ray": "call-FRA",
            "cf-placement": "remote-LHR",
          },
        },
      );
    });
    const driver = createHttpDriver({
      runId: "timing",
      baseUrl: "https://example.com",
      token: "test",
      projectId: "test",
    });
    const [participant] = await driver.participants(1, 1);
    const rec = new Recorder();
    rec.start();
    const outcome = await timed("list", () => participant.tila.claims.list());
    rec.record(outcome);
    expect(outcome.cls).toBe("ok");
    expect(outcome.httpTimings).toHaveLength(1);
    expect(driver.describe().region).toMatchObject({
      cf_colo: "FRA",
      cf_placement: "remote-LHR",
    });
    const snapshot = rec.snapshot();
    expect(
      renderScenario({
        name: "test",
        description: "test",
        participants: 1,
        window_s: 1,
        dataset: {},
        ...snapshot,
        invariants: [],
        extra: {},
      }),
    ).toContain("1/1 HTTP responses covered");
  });

  it("probes the actual health route", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, {
        headers: { "cf-ray": "abc-WAW", "cf-placement": "remote-FRA" },
      }),
    );
    expect(await probeRegion("https://example.com/")).toEqual({
      cf_colo: "WAW",
      cf_placement: "remote-FRA",
    });
    expect(fetch.mock.calls[0][0]).toBe("https://example.com/api/health");
  });
});
