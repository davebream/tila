import { classifyError } from "./classify";
import { type HttpTimingSample, timingContext } from "./server-timing";
import type { OpOutcome } from "./types";

export interface Timed<T> extends OpOutcome {
  value?: T;
}

/** Time one facade call and classify its result. Never throws. */
export async function timed<T>(
  op: string,
  fn: () => Promise<T>,
): Promise<Timed<T>> {
  const t0 = performance.now();
  const samples: HttpTimingSample[] = [];
  try {
    const value = await timingContext.run(samples, fn);
    return {
      op,
      cls: "ok",
      latencyMs: performance.now() - t0,
      startedAt: t0,
      httpTimings: samples,
      value,
    };
  } catch (err) {
    const c = classifyError(err);
    return {
      op,
      cls: c.cls,
      latencyMs: performance.now() - t0,
      startedAt: t0,
      httpTimings: samples,
      status: c.status,
      code: c.code,
      message: c.message,
    };
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener("abort", done);
      clearTimeout(t);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** Let timers and other participants run (in-process tiers never block). */
export function yieldMacrotask(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Deterministic PRNG (mulberry32) so participant pairings are reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic pseudo-random bytes for artifact payloads. */
export function pseudoRandomBytes(size: number, seed: number): Uint8Array {
  const out = new Uint8Array(size);
  const rng = mulberry32(seed);
  for (let i = 0; i < size; i++) out[i] = Math.floor(rng() * 256);
  return out;
}
