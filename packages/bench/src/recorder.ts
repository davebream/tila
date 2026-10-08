import type { z } from "zod";
import { Histogram, type LatencySummary } from "./histogram";
import type { TimingSummarySchema } from "./result-schema";
import type { OpOutcome, OutcomeClass, RecorderView } from "./types";

export interface ErrorSample {
  op: string;
  status?: number;
  code?: string;
  message: string;
}

export interface Metrics {
  timing?: z.infer<typeof TimingSummarySchema>;
  ops: number;
  ok: number;
  conflicts: number;
  stale_fence: number;
  errors: number;
  error_rate: number;
  throughput_ops_s: number;
  latency_ms: LatencySummary;
  error_samples: ErrorSample[];
}

const MAX_ERROR_SAMPLES = 5;

class OpAccumulator {
  hist = new Histogram();
  ok = 0;
  conflicts = 0;
  stale_fence = 0;
  errors = 0;
  samples: ErrorSample[] = [];
  timingHists = new Map<string, Histogram>();
  requests = 0;
  timedRequests = 0;
  invalidResiduals = 0;
  locations: Record<string, number> = {};

  timingMetric(name: string, value: number): void {
    let hist = this.timingHists.get(name);
    if (!hist) {
      hist = new Histogram();
      this.timingHists.set(name, hist);
    }
    hist.record(value);
  }

  add(o: OpOutcome): void {
    this.hist.record(o.latencyMs);
    const samples = o.httpTimings ?? [];
    this.requests += samples.length;
    for (const sample of samples) {
      const location = `${sample.colo ?? "unknown"}/${sample.placement ?? "unknown"}`;
      // Bounded cardinality, even if a proxy supplies arbitrary header values.
      const key =
        Object.hasOwn(this.locations, location) ||
        Object.keys(this.locations).length < 32
          ? location.slice(0, 100)
          : "other";
      this.locations[key] = (this.locations[key] ?? 0) + 1;
      if (!sample.server) continue;
      this.timedRequests++;
      for (const [name, value] of Object.entries(sample.server))
        this.timingMetric(name, value);
    }
    // A facade may make several HTTP requests. Only subtract a matched single
    // response from the complete facade duration (includes parsing and SDK work).
    if (samples.length === 1 && samples[0].server) {
      this.timingMetric("client", o.latencyMs);
      const residual = o.latencyMs - samples[0].server.worker;
      if (residual >= 0) this.timingMetric("transport_client", residual);
      else this.invalidResiduals++;
    }
    switch (o.cls) {
      case "ok":
        this.ok++;
        break;
      case "conflict":
        this.conflicts++;
        break;
      case "stale_fence":
        this.stale_fence++;
        break;
      case "error":
        this.errors++;
        if (this.samples.length < MAX_ERROR_SAMPLES)
          this.samples.push({
            op: o.op,
            status: o.status,
            code: o.code,
            message: (o.message ?? "").slice(0, 300),
          });
        break;
    }
  }

  count(cls?: OutcomeClass): number {
    switch (cls) {
      case undefined:
        return this.hist.count;
      case "ok":
        return this.ok;
      case "conflict":
        return this.conflicts;
      case "stale_fence":
        return this.stale_fence;
      case "error":
        return this.errors;
    }
  }

  metrics(windowSec: number): Metrics {
    const ops = this.hist.count;
    return {
      ...(this.requests
        ? {
            timing: {
              requests: this.requests,
              timed_requests: this.timedRequests,
              invalid_residuals: this.invalidResiduals,
              metrics: Object.fromEntries(
                [...this.timingHists].map(([name, hist]) => [
                  name,
                  { count: hist.count, ...hist.summary() },
                ]),
              ),
              locations: this.locations,
            },
          }
        : {}),
      ops,
      ok: this.ok,
      conflicts: this.conflicts,
      stale_fence: this.stale_fence,
      errors: this.errors,
      error_rate: ops === 0 ? 0 : this.errors / ops,
      throughput_ops_s:
        windowSec > 0 ? Math.round((ops / windowSec) * 100) / 100 : 0,
      latency_ms: this.hist.summary(),
      error_samples: this.samples,
    };
  }
}

/**
 * Accumulates outcomes per operation name plus a grand total. Only records
 * while `recording` is true (warmup is excluded by the load loop).
 */
export class Recorder implements RecorderView {
  private byOp = new Map<string, OpAccumulator>();
  private totals = new OpAccumulator();
  private startedAt: number | null = null;
  private endedAt: number | null = null;
  recording = false;

  start(): void {
    this.startedAt = performance.now();
    this.endedAt = null;
    this.recording = true;
  }

  stop(): void {
    this.endedAt = performance.now();
    this.recording = false;
  }

  /** Seconds between start() and stop() (or now). */
  windowSeconds(): number {
    if (this.startedAt === null) return 0;
    const end = this.endedAt ?? performance.now();
    return (end - this.startedAt) / 1000;
  }

  record(o: OpOutcome): void {
    if (
      !this.recording ||
      (o.startedAt !== undefined &&
        this.startedAt !== null &&
        o.startedAt < this.startedAt)
    )
      return;
    let acc = this.byOp.get(o.op);
    if (!acc) {
      acc = new OpAccumulator();
      this.byOp.set(o.op, acc);
    }
    acc.add(o);
    this.totals.add(o);
  }

  count(op: string, cls?: OutcomeClass): number {
    return this.byOp.get(op)?.count(cls) ?? 0;
  }

  total(cls?: OutcomeClass): number {
    return this.totals.count(cls);
  }

  ops(): string[] {
    return [...this.byOp.keys()].sort();
  }

  snapshot(): { ops: Record<string, Metrics>; totals: Metrics } {
    const window = this.windowSeconds();
    const ops: Record<string, Metrics> = {};
    for (const name of this.ops()) {
      const acc = this.byOp.get(name);
      if (acc) ops[name] = acc.metrics(window);
    }
    const totals = this.totals.metrics(window);
    const sum =
      totals.ok + totals.conflicts + totals.stale_fence + totals.errors;
    if (sum !== totals.ops)
      throw new Error(`recorder invariant violated: ${sum} !== ${totals.ops}`);
    return { ops, totals };
  }
}
