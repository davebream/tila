/**
 * CI smoke subset: every scenario runs in-process for a fixed number of
 * iterations and only invariants are asserted. No absolute latency budgets —
 * CI hardware varies; the point is that the harness and the coordination
 * semantics it measures stay correct.
 */
import { describe, expect, it, vi } from "vitest";
import { createInprocDriver } from "../src/drivers/inproc";
import { type RunOptionsInput, defaultOptions } from "../src/options";
import { renderResult } from "../src/report";
import { type BenchResult, BenchResultSchema } from "../src/result-schema";
import { runBenchmark } from "../src/runner";
import { coldStart } from "../src/scenarios/cold-start";
import type { Participant, ScenarioContext } from "../src/types";

const ITERATIONS = 20;

describe("cold-start restart contract", () => {
  it.each([
    [200, { ok: true }, true],
    [200, { ok: false }, false],
    [200, {}, false],
    [202, { ok: true }, false],
    [401, { ok: false }, false],
    [403, { ok: false }, false],
    [404, { ok: false }, false],
    [500, { ok: false }, false],
    [503, { ok: false }, false],
  ] as const)(
    "validates the restart acknowledgement: HTTP %s %j",
    async (status, body, acknowledged) => {
      vi.useFakeTimers();
      try {
        const ctx = {
          extra: {},
          signal: new AbortController().signal,
        } as ScenarioContext;
        const read = vi.fn().mockResolvedValue({});
        const participant = {
          index: 0,
          projectId: "restart-probe",
          rawFetch: vi.fn().mockResolvedValue(Response.json(body, { status })),
          tila: { summary: { get: read } },
        } as unknown as Participant;
        await coldStart.setup(ctx);
        const pending = coldStart.op(ctx, participant);
        await vi.runAllTimersAsync();
        const outcomes = await pending;

        expect(outcomes[0].cls).toBe(acknowledged ? "ok" : "error");
        expect(ctx.extra.restarts).toBe(acknowledged ? 1 : 0);
        expect(ctx.extra.restart_failures).toBe(acknowledged ? 0 : 1);
        expect(read).toHaveBeenCalledTimes(acknowledged ? 4 : 0);
      } finally {
        vi.useRealTimers();
      }
    },
  );
});

async function run(partial: RunOptionsInput): Promise<BenchResult> {
  const opts = defaultOptions({
    tier: "inproc",
    participants: 4,
    iterations: ITERATIONS,
    warmupMs: 0,
    quiet: true,
    ...partial,
  });
  return runBenchmark(opts, { cwd: process.cwd() });
}

function scenario(result: BenchResult, name: string) {
  const s = result.scenarios.find((x) => x.name === name);
  if (!s) throw new Error(`scenario ${name} missing from result`);
  return s;
}

function expectInvariants(result: BenchResult) {
  for (const s of result.scenarios)
    for (const inv of s.invariants)
      expect(inv.ok, `${s.name}: ${inv.name} ${inv.detail ?? ""}`).toBe(true);
}

function expectSane(result: BenchResult) {
  for (const s of result.scenarios) {
    const t = s.totals;
    expect(t.ok + t.conflicts + t.stale_fence + t.errors).toBe(t.ops);
    expect(t.errors).toBe(0);
    if (t.ops > 0) {
      expect(t.latency_ms.p50).toBeGreaterThan(0);
      expect(t.latency_ms.p50).toBeLessThanOrEqual(t.latency_ms.p95);
      expect(t.latency_ms.p95).toBeLessThanOrEqual(t.latency_ms.p99);
      expect(t.latency_ms.p99).toBeLessThanOrEqual(t.latency_ms.max);
      expect(Number.isFinite(t.throughput_ops_s)).toBe(true);
    }
  }
}

describe("benchmark smoke (in-process)", () => {
  it("claims-uncontended: every cycle succeeds", async () => {
    const r = await run({ scenario: "claims-uncontended" });
    const s = scenario(r, "claims-uncontended");
    expect(s.totals.ops).toBe(4 * ITERATIONS * 5);
    expect(s.totals.conflicts).toBe(0);
    expectSane(r);
    expectInvariants(r);
  });

  it("claims-contended exclusive: a burst of concurrent acquires has exactly one winner", async () => {
    const driver = createInprocDriver({ runId: "burst" });
    try {
      const participants = await driver.participants(8, 1);
      const outcomes = await Promise.all(
        participants.map((p) =>
          p.tila.claims.acquire("bench:burst:hot", "exclusive", 10_000).then(
            () => "ok",
            (err: { status?: number; code?: string }) =>
              err.status === 409 && err.code === "already-held"
                ? "conflict"
                : "error",
          ),
        ),
      );
      expect(outcomes.filter((o) => o === "ok")).toHaveLength(1);
      expect(outcomes.filter((o) => o === "conflict")).toHaveLength(7);
      expect(outcomes.filter((o) => o === "error")).toHaveLength(0);
    } finally {
      await driver.cleanup();
    }
  });

  it("claims-contended exclusive: losers conflict, nobody errors, fences never regress", async () => {
    const r = await run({ scenario: "claims-contended", participants: 6 });
    const s = scenario(r, "claims-contended");
    expect(s.totals.conflicts).toBeGreaterThan(0);
    expect(s.extra.journal_fence_regressions).toBe(0);
    expect(s.extra.journal_acquires_audited).toBeGreaterThan(0);
    expectSane(r);
    expectInvariants(r);
  });

  it("claims-contended owner: same-principal participants take over and bump the fence", async () => {
    const r = await run({
      scenario: "claims-contended",
      participants: 4,
      params: { mode: "owner" },
    });
    const s = scenario(r, "claims-contended");
    expect(s.extra.takeovers).toBeGreaterThan(0);
    expect(s.totals.stale_fence).toBeGreaterThan(0);
    expect(s.extra.journal_fence_regressions).toBe(0);
    expect(s.extra.journal_acquires_audited).toBeGreaterThan(0);
    expectSane(r);
    expectInvariants(r);
  });

  it("claims-contended owner across principals: cross-principal attempts are conflicts", async () => {
    const r = await run({
      scenario: "claims-contended",
      participants: 4,
      principals: 2,
      params: { mode: "owner" },
    });
    const s = scenario(r, "claims-contended");
    expect(s.totals.conflicts).toBeGreaterThan(0);
    expectSane(r);
    expectInvariants(r);
  });

  it("fenced-writes tasks: stale fences are rejected and holders recover", async () => {
    const r = await run({
      scenario: "fenced-writes",
      participants: 4,
      params: { stealEvery: 2 },
    });
    const s = scenario(r, "fenced-writes");
    expect(s.totals.stale_fence).toBeGreaterThan(0);
    expect(s.ops.update.ok).toBeGreaterThan(0);
    expect(s.extra.reacquires).toBeGreaterThan(0);
    expectSane(r);
    expectInvariants(r);
  });

  it("fenced-writes records: CAS losers refresh and retry", async () => {
    const r = await run({
      scenario: "fenced-writes",
      participants: 4,
      params: { target: "records" },
    });
    const s = scenario(r, "fenced-writes");
    expect(s.totals.stale_fence).toBeGreaterThan(0);
    expect(s.ops.set.ok).toBeGreaterThan(0);
    expectSane(r);
    expectInvariants(r);
  });

  it("presence-signals: participant targets deliver without presence and drain clean", async () => {
    const r = await run({ scenario: "presence-signals" });
    const s = scenario(r, "presence-signals");
    expect(s.ops.send.ok).toBe(4 * ITERATIONS);
    expect(s.extra.signals_acked).toBeGreaterThanOrEqual(s.extra.signals_sent);
    expectSane(r);
    expectInvariants(r);
  });

  it("journal-replay: readers page without gaps or regressions", async () => {
    const r = await run({ scenario: "journal-replay" });
    const s = scenario(r, "journal-replay");
    expect(s.ops.replay.ok).toBeGreaterThan(0);
    expect(s.ops.acknowledge.ok).toBeGreaterThan(0);
    expect(s.extra.seq_gaps).toBe(0);
    expect(s.extra.seq_regressions).toBe(0);
    expectSane(r);
    expectInvariants(r);
  });

  it("artifacts: uploads round-trip through metadata", async () => {
    const r = await run({
      scenario: "artifacts",
      participants: 2,
      iterations: 6,
      params: { sizesBytes: [1024, 65_536] },
    });
    const s = scenario(r, "artifacts");
    expect(s.ops.upload_1k.ok).toBeGreaterThan(0);
    expect(s.ops.upload_64k.ok).toBeGreaterThan(0);
    expect(s.extra.meta_size_mismatches).toBe(0);
    expectSane(r);
    expectInvariants(r);
  });

  it("mix: scenarios run concurrently on partitioned participants", async () => {
    const r = await run({ scenario: "mix", participants: 8, iterations: 10 });
    expect(r.scenarios.map((s) => s.name).sort()).toEqual(
      [
        "claims-contended",
        "fenced-writes",
        "journal-replay",
        "presence-signals",
      ].sort(),
    );
    for (const s of r.scenarios) expect(s.participants).toBe(2);
    expectSane(r);
  });

  it("soak sampling records store growth and sweep results", async () => {
    const r = await run({
      scenario: "claims-uncontended",
      participants: 2,
      iterations: 10,
      soak: true,
      sampleIntervalMs: 50,
      sweepEveryMs: 1,
    });
    expect(r.soak).not.toBeNull();
    const samples = r.soak?.samples ?? [];
    expect(samples.length).toBeGreaterThanOrEqual(2);
    const last = samples[samples.length - 1];
    expect(last.db_bytes).toBeGreaterThan(0);
    expect(last.counts?.journal).toBeGreaterThan(0);
    expect(samples.some((s) => s.sweep !== null)).toBe(true);
  });

  it("result validates against the schema and renders every scenario", async () => {
    const r = await run({ scenario: "all", participants: 2, iterations: 3 });
    expect(() =>
      BenchResultSchema.parse(JSON.parse(JSON.stringify(r))),
    ).not.toThrow();
    const md = renderResult(r);
    for (const s of r.scenarios) expect(md).toContain(`#### ${s.name}`);
    expect(md).toContain("| op | ops | ok |");
    expect(r.params.iterations).toBe(3);
    expect(r.tier).toBe("inproc");
    expect(r.harness_version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
