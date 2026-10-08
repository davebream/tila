import type { Context, MiddlewareHandler } from "hono";
import type { Env, HonoVariables } from "../types";

export const TIMING_PHASES = [
  "auth_rate_limit",
  "auth_token",
  "auth_credential",
  "membership",
  "transfer",
  "do",
] as const;
type Phase = (typeof TIMING_PHASES)[number];
type AppEnv = { Bindings: Env; Variables: HonoVariables };

/** Request-local wall time. Clocks in deployed Workers advance only on I/O. */
export class RequestTiming {
  private started = performance.now();
  private spans: { phase: Phase; start: number; end: number }[] = [];

  async measure<T>(phase: Phase, fn: () => Promise<T>): Promise<T> {
    const start = performance.now();
    try {
      return await fn();
    } finally {
      this.spans.push({ phase, start, end: performance.now() });
    }
  }

  header(): string {
    const total = performance.now() - this.started;
    const values = Object.fromEntries(TIMING_PHASES.map((p) => [p, 0]));
    // Attribute overlapping waits once, in start order. Claims are sequential;
    // aggregate routes may issue concurrent DO calls. Never double-count them.
    let coveredUntil = this.started;
    for (const span of [...this.spans].sort((a, b) => a.start - b.start)) {
      values[span.phase] += Math.max(
        0,
        span.end - Math.max(coveredUntil, span.start),
      );
      coveredUntil = Math.max(coveredUntil, span.end);
    }
    const covered = Object.values(values).reduce((a, b) => a + b, 0);
    return Object.entries({
      worker: total,
      ...values,
      worker_other: Math.max(0, total - covered),
    })
      .map(([name, ms]) => `tila_${name};dur=${ms.toFixed(3)}`)
      .join(", ");
  }
}

export function measurePhase<T>(
  c: Context<AppEnv>,
  phase: Phase,
  fn: () => Promise<T>,
): Promise<T> {
  return c.get("requestTiming")?.measure(phase, fn) ?? fn();
}

export const serverTimingMiddleware: MiddlewareHandler<AppEnv> = async (
  c,
  next,
) => {
  const timing = new RequestTiming();
  c.set("requestTiming", timing);
  await next();
  // Append preserves metrics emitted by another layer; no response buffering.
  c.header("Server-Timing", timing.header(), { append: true });
};
