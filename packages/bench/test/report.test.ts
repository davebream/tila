import { describe, expect, it } from "vitest";
import { parseDuration, parseSizes } from "../src/options";
import { renderBaseline } from "../src/report";
import type { BenchResult } from "../src/result-schema";

const metrics = (ops: number) => ({
  ops,
  ok: ops,
  conflicts: 0,
  stale_fence: 0,
  errors: 0,
  error_rate: 0,
  throughput_ops_s: ops / 10,
  latency_ms: { p50: 1, p95: 2, p99: 3, max: 4, mean: 1.5 },
  error_samples: [],
});

function fakeResult(runId: string, startedAt: string): BenchResult {
  return {
    harness_version: "1.0.0",
    schema_version: 1,
    run_id: runId,
    started_at: startedAt,
    finished_at: startedAt,
    git: { sha: "abc123def456", dirty: false },
    tier: "http",
    target: {
      base_url_host: "tila.example.workers.dev",
      deployed: true,
      region: { cf_colo: "WAW" },
      notes: [],
    },
    hardware: {
      platform: "darwin",
      arch: "arm64",
      cpu_model: "M",
      cpu_count: 8,
      total_mem_bytes: 1024 ** 3,
      node_version: "v24",
    },
    params: {
      scenario: "claims-uncontended",
      participants: 4,
      principals: 1,
      duration_ms: 10_000,
      warmup_ms: 1000,
      iterations: null,
      cadence_ms: 500,
      mode: "exclusive",
      groups: 1,
      hold_ms: 0,
      target: "tasks",
      steal_every: 5,
      sizes_bytes: [1024],
      writers: null,
      cold_start_iterations: 5,
      seed: 42,
      soak: false,
      sample_interval_ms: null,
    },
    scenarios: [
      {
        name: "claims-uncontended",
        description: "d",
        participants: 4,
        window_s: 10,
        dataset: { resources: 4 },
        ops: { acquire: metrics(100) },
        totals: metrics(100),
        invariants: [{ name: "no errors", ok: true }],
        extra: { missed_cadence_deadlines: 0 },
      },
    ],
    soak: null,
  };
}

describe("report", () => {
  it("renders newest run first with environment and metrics tables", () => {
    const md = renderBaseline([
      fakeResult("older", "2026-10-01T00:00:00.000Z"),
      fakeResult("newer", "2026-10-02T00:00:00.000Z"),
    ]);
    expect(md.indexOf("newer")).toBeLessThan(md.indexOf("older"));
    expect(md).toContain("colo WAW");
    expect(md).toContain("cadence 500 ms");
    expect(md).toContain(
      "| acquire | 100 | 100 | 0 | 0 | 0 | 10 | 1 | 2 | 3 | 4 |",
    );
    expect(md).toContain("PASS no errors");
  });
});

describe("option parsing", () => {
  it("parses durations", () => {
    expect(parseDuration("500ms", 0)).toBe(500);
    expect(parseDuration("30s", 0)).toBe(30_000);
    expect(parseDuration("2h", 0)).toBe(7_200_000);
    expect(parseDuration("1.5m", 0)).toBe(90_000);
    expect(parseDuration(undefined, 7)).toBe(7);
    expect(() => parseDuration("soon", 0)).toThrow();
  });
  it("parses sizes", () => {
    expect(parseSizes("1k,64k,1m")).toEqual([1024, 65_536, 1_048_576]);
    expect(parseSizes("512")).toEqual([512]);
  });
});
