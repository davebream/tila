import type { SoakSample } from "./result-schema";
import type { Driver } from "./types";

export interface SoakOptions {
  intervalMs: number;
  sweepEveryMs?: number;
  log: (msg: string) => void;
}

export interface SoakSampler {
  stop(): Promise<SoakSample[]>;
}

/**
 * Periodically sample process memory and backend store size/counts, and
 * optionally trigger the sweep so its cost and effect show up in the series.
 */
export function startSoakSampler(
  driver: Driver,
  opts: SoakOptions,
): SoakSampler {
  const samples: SoakSample[] = [];
  const t0 = performance.now();
  let lastSweep = t0;
  let running = true;
  let inFlight: Promise<void> = Promise.resolve();

  async function sample(): Promise<void> {
    const now = performance.now();
    const mem = process.memoryUsage();
    const entry: SoakSample = {
      t_ms: Math.round(now - t0),
      rss_bytes: mem.rss,
      heap_used_bytes: mem.heapUsed,
      db_bytes: null,
      counts: null,
      sweep: null,
    };
    try {
      const store = await driver.sampleStore?.();
      if (store) {
        entry.db_bytes = store.db_bytes;
        entry.counts = store.counts;
      }
    } catch (err) {
      opts.log(`soak: store sample failed: ${(err as Error).message}`);
    }
    if (
      opts.sweepEveryMs &&
      driver.sweep &&
      now - lastSweep >= opts.sweepEveryMs
    ) {
      lastSweep = now;
      try {
        entry.sweep = await driver.sweep();
      } catch (err) {
        opts.log(`soak: sweep failed: ${(err as Error).message}`);
      }
    }
    samples.push(entry);
    const parts = [
      `soak t=${(entry.t_ms / 1000).toFixed(0)}s`,
      `rss=${(entry.rss_bytes / 1048576).toFixed(1)}MiB`,
    ];
    if (entry.db_bytes !== null)
      parts.push(`db=${(entry.db_bytes / 1048576).toFixed(2)}MiB`);
    if (entry.counts) parts.push(`journal=${entry.counts.journal ?? "?"}`);
    if (entry.sweep) parts.push("sweep=yes");
    opts.log(parts.join(" "));
  }

  const timer = setInterval(() => {
    if (!running) return;
    inFlight = inFlight.then(sample);
  }, opts.intervalMs);
  inFlight = sample();

  return {
    async stop() {
      running = false;
      clearInterval(timer);
      await inFlight;
      await sample();
      return samples;
    },
  };
}
