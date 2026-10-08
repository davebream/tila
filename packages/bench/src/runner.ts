import { createDriver } from "./drivers/driver";
import { gitInfo, hardwareInfo, makeRunId } from "./env-info";
import { runLoad } from "./load-loop";
import { mulberry32 } from "./measure";
import type { RunOptions } from "./options";
import { Recorder } from "./recorder";
import {
  type BenchResult,
  BenchResultSchema,
  HARNESS_VERSION,
  SCHEMA_VERSION,
  type ScenarioResult,
  type SoakSample,
} from "./result-schema";
import { resolveScenarios } from "./scenarios/index";
import { startSoakSampler } from "./soak";
import type { Driver, Participant, Scenario, ScenarioContext } from "./types";

export interface RunHooks {
  log?: (msg: string) => void;
  signal?: AbortSignal;
  /** Repo root for git metadata; defaults to cwd. */
  cwd?: string;
}

/**
 * Run the selected scenarios on one tier and return the versioned result.
 * `all` runs scenarios one after another with every participant; `mix` runs
 * the coordination scenarios concurrently with participants partitioned
 * across them (the soak workload).
 */
export async function runBenchmark(
  opts: RunOptions,
  hooks: RunHooks = {},
): Promise<BenchResult> {
  const log = hooks.log ?? (() => {});
  const runId = makeRunId();
  const startedAt = new Date();
  const driver = createDriver(opts, runId);
  const scenarios = resolveScenarios(opts.scenario);
  for (const s of scenarios) {
    if (!s.tiers.includes(opts.tier))
      throw new Error(`Scenario ${s.name} does not support tier ${opts.tier}`);
  }
  const concurrent = opts.scenario === "mix";
  const outer = new AbortController();
  hooks.signal?.addEventListener("abort", () => outer.abort(), { once: true });

  const results: ScenarioResult[] = [];
  let soakSamples: SoakSample[] | null = null;
  try {
    log(
      `run ${runId}: tier=${opts.tier} scenario=${opts.scenario} participants=${opts.participants}`,
    );
    const participants = await driver.participants(
      opts.participants,
      opts.principals,
    );
    const sampler = opts.soak
      ? startSoakSampler(driver, {
          intervalMs: opts.sampleIntervalMs,
          sweepEveryMs: opts.sweepEveryMs,
          log,
        })
      : null;
    try {
      if (concurrent) {
        const slices = partition(participants, scenarios.length);
        const runs = scenarios.map((s, i) =>
          runOne(s, slices[i], opts, driver, runId, outer.signal, log),
        );
        results.push(...(await Promise.all(runs)));
      } else {
        for (const s of scenarios) {
          if (outer.signal.aborted) break;
          results.push(
            await runOne(
              s,
              participants,
              opts,
              driver,
              runId,
              outer.signal,
              log,
            ),
          );
        }
      }
    } finally {
      if (sampler) soakSamples = await sampler.stop();
    }
  } finally {
    await driver.cleanup();
  }

  const described = driver.describe();
  const result: BenchResult = {
    harness_version: HARNESS_VERSION,
    schema_version: SCHEMA_VERSION,
    run_id: runId,
    started_at: startedAt.toISOString(),
    finished_at: new Date().toISOString(),
    git: gitInfo(hooks.cwd ?? process.cwd()),
    tier: opts.tier,
    target: {
      base_url_host: described.base_url_host,
      deployed: described.deployed,
      region: described.region,
      notes: described.notes,
    },
    hardware: hardwareInfo(),
    params: {
      scenario: opts.scenario,
      participants: opts.participants,
      principals: opts.principals,
      duration_ms: opts.durationMs,
      warmup_ms: opts.warmupMs,
      iterations: opts.iterations ?? null,
      cadence_ms: opts.cadenceMs ?? null,
      mode: opts.params.mode,
      groups: opts.params.groups,
      hold_ms: opts.params.holdMs,
      target: opts.params.target,
      steal_every: opts.params.stealEvery,
      sizes_bytes: opts.params.sizesBytes,
      writers: opts.params.writers ?? null,
      cold_start_iterations: opts.params.coldStartIterations,
      seed: opts.seed,
      soak: opts.soak,
      sample_interval_ms: opts.soak ? opts.sampleIntervalMs : null,
    },
    scenarios: results,
    soak: soakSamples
      ? { interval_ms: opts.sampleIntervalMs, samples: soakSamples }
      : null,
  };
  return BenchResultSchema.parse(result);
}

async function runOne(
  scenario: Scenario,
  participants: Participant[],
  opts: RunOptions,
  driver: Driver,
  runId: string,
  signal: AbortSignal,
  log: (msg: string) => void,
): Promise<ScenarioResult> {
  const rec = new Recorder();
  const controller = new AbortController();
  const stopOnOuter = () => controller.abort();
  signal.addEventListener("abort", stopOnOuter, { once: true });
  const ctx: ScenarioContext = {
    runId,
    tier: opts.tier,
    cadenceMs: opts.cadenceMs,
    seed: opts.seed,
    rng: mulberry32(opts.seed ^ hash(scenario.name)),
    participants,
    params: opts.params,
    signal: controller.signal,
    log,
    extra: {},
  };
  log(`${scenario.name}: setup (${participants.length} participants)`);
  await scenario.setup(ctx);
  const iterations =
    scenario.name === "cold-start"
      ? opts.params.coldStartIterations
      : opts.iterations;
  const loopParticipants =
    scenario.name === "cold-start" ? participants.slice(0, 1) : participants;
  const t0 = performance.now();
  try {
    await runLoad(
      ctx,
      scenario,
      rec,
      {
        durationMs: opts.durationMs,
        warmupMs: opts.warmupMs,
        iterations,
        cadenceMs: opts.cadenceMs,
        participants: loopParticipants,
      },
      controller,
    );
  } finally {
    signal.removeEventListener("abort", stopOnOuter);
    log(`${scenario.name}: teardown`);
    // Teardown runs after the deadline; give it a live signal for its sleeps.
    const teardownCtx: ScenarioContext = {
      ...ctx,
      signal: new AbortController().signal,
    };
    await scenario.teardown(teardownCtx);
  }
  const snap = rec.snapshot();
  const invariants = scenario.invariants?.(ctx, rec) ?? [];
  for (const inv of invariants)
    if (!inv.ok)
      log(
        `${scenario.name}: INVARIANT FAILED: ${inv.name} ${inv.detail ?? ""}`,
      );
  log(
    `${scenario.name}: ${snap.totals.ops} ops in ${((performance.now() - t0) / 1000).toFixed(1)}s ` +
      `(${snap.totals.throughput_ops_s} ops/s, p50 ${snap.totals.latency_ms.p50}ms, p99 ${snap.totals.latency_ms.p99}ms, ` +
      `conflicts ${snap.totals.conflicts}, stale ${snap.totals.stale_fence}, errors ${snap.totals.errors})`,
  );
  return {
    name: scenario.name,
    description: scenario.description,
    participants: loopParticipants.length,
    window_s: Math.round(rec.windowSeconds() * 1000) / 1000,
    dataset: scenario.dataset?.(ctx) ?? {},
    ops: snap.ops,
    totals: snap.totals,
    invariants,
    extra: ctx.extra,
  };
}

function partition<T>(items: T[], buckets: number): T[][] {
  const out: T[][] = Array.from({ length: buckets }, () => []);
  items.forEach((item, i) => out[i % buckets].push(item));
  // Every bucket needs at least one participant; reuse from the front if short.
  for (let b = 0; b < buckets; b++)
    if (out[b].length === 0 && items.length > 0) out[b].push(items[0]);
  return out;
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++)
    h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
