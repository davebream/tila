import { classifyError } from "./classify";
import { sleep, yieldMacrotask } from "./measure";
import type { Recorder } from "./recorder";
import type { Participant, Scenario, ScenarioContext } from "./types";

export interface LoadOptions {
  /** Wall-clock budget for the recorded window. Mutually exclusive with iterations. */
  durationMs?: number;
  /** Warmup before recording starts (time-based runs only). */
  warmupMs?: number;
  /** Fixed iterations per participant (CI smoke). */
  iterations?: number;
  /** Target period per iteration per participant; missed deadlines are counted. */
  cadenceMs?: number;
  /** Only these participants run the loop (default: all). */
  participants?: Participant[];
}

/**
 * Closed-loop load: one async worker per participant, each running
 * `scenario.op` back to back (or on a fixed cadence) until the deadline or
 * iteration count. Latency is measured by the scenario around each facade
 * call; the loop only classifies unexpected throws.
 *
 * `controller` must own `ctx.signal`; the loop aborts it at the deadline so
 * scenarios see the same context object in setup, op and teardown.
 */
export async function runLoad(
  ctx: ScenarioContext,
  scenario: Scenario,
  rec: Recorder,
  opts: LoadOptions,
  controller: AbortController,
): Promise<void> {
  const participants = opts.participants ?? ctx.participants;
  const signal = controller.signal;
  const loopCtx = ctx;

  let deadlineTimer: NodeJS.Timeout | undefined;
  let warmupTimer: NodeJS.Timeout | undefined;
  if (opts.iterations === undefined) {
    const warmup = opts.warmupMs ?? 0;
    const duration = opts.durationMs ?? 10_000;
    if (warmup > 0) warmupTimer = setTimeout(() => rec.start(), warmup);
    else rec.start();
    deadlineTimer = setTimeout(() => controller.abort(), warmup + duration);
  } else {
    rec.start();
  }

  const workers = participants.map((p) =>
    participantLoop(loopCtx, scenario, rec, p, opts, signal),
  );
  try {
    await Promise.all(workers);
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer);
    if (warmupTimer) clearTimeout(warmupTimer);
    if (rec.recording) rec.stop();
    controller.abort();
  }
}

async function participantLoop(
  ctx: ScenarioContext,
  scenario: Scenario,
  rec: Recorder,
  p: Participant,
  opts: LoadOptions,
  signal: AbortSignal,
): Promise<void> {
  let i = 0;
  while (!signal.aborted) {
    if (opts.iterations !== undefined && i >= opts.iterations) break;
    const t0 = performance.now();
    try {
      const outcomes = await scenario.op(ctx, p);
      for (const o of outcomes) rec.record(o);
    } catch (err) {
      const c = classifyError(err);
      rec.record({
        op: `${scenario.name}.op`,
        cls: "error",
        latencyMs: performance.now() - t0,
        status: c.status,
        code: c.code,
        message: c.message,
      });
    }
    i++;
    // In-process tiers resolve every call through microtasks alone, which
    // starves timers (deadline, warmup, soak sampler). Yield one macrotask.
    await yieldMacrotask();
    if (opts.cadenceMs) {
      const elapsed = performance.now() - t0;
      const remaining = opts.cadenceMs - elapsed;
      if (remaining < 0) {
        if (rec.recording)
          ctx.extra.missed_cadence_deadlines =
            (ctx.extra.missed_cadence_deadlines ?? 0) + 1;
      } else {
        await sleep(remaining, signal);
      }
    }
  }
}
