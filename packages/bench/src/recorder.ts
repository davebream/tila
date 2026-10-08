import { Histogram, type LatencySummary } from "./histogram";
import type { OpOutcome, OutcomeClass, RecorderView } from "./types";

export interface ErrorSample {
  op: string;
  status?: number;
  code?: string;
  message: string;
}

export interface Metrics {
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

  add(o: OpOutcome): void {
    this.hist.record(o.latencyMs);
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
    if (!this.recording) return;
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
