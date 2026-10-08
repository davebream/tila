import { describe, expect, it } from "vitest";
import { Histogram } from "../src/histogram";

function oracle(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(p * sorted.length) - 1),
  );
  return sorted[idx];
}

describe("Histogram", () => {
  it("tracks count, min, max, mean exactly", () => {
    const h = new Histogram();
    for (const v of [1, 2, 3, 4, 100]) h.record(v);
    expect(h.count).toBe(5);
    expect(h.min).toBe(1);
    expect(h.max).toBe(100);
    expect(h.mean).toBeCloseTo(22, 5);
  });

  it("returns zeros when empty", () => {
    const h = new Histogram();
    expect(h.summary()).toEqual({ p50: 0, p95: 0, p99: 0, max: 0, mean: 0 });
  });

  it("percentiles are within 4% of a sorted-array oracle on log-normal data", () => {
    const h = new Histogram();
    const values: number[] = [];
    let seed = 7;
    const rng = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    for (let i = 0; i < 20_000; i++) {
      // Box-Muller → log-normal around ~5 ms with a long tail.
      const u = Math.max(rng(), 1e-9);
      const v = rng();
      const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
      const ms = Math.exp(Math.log(5) + 0.8 * z);
      values.push(ms);
      h.record(ms);
    }
    for (const p of [0.5, 0.9, 0.95, 0.99]) {
      const expected = oracle(values, p);
      const got = h.percentile(p);
      expect(Math.abs(got - expected) / expected).toBeLessThan(0.04);
    }
    expect(h.percentile(1)).toBe(Math.max(...values));
    expect(h.percentile(0)).toBe(Math.min(...values));
  });

  it("orders p50 <= p95 <= p99 <= max", () => {
    const h = new Histogram();
    for (let i = 1; i <= 1000; i++) h.record(i * 0.37);
    const s = h.summary();
    expect(s.p50).toBeLessThanOrEqual(s.p95);
    expect(s.p95).toBeLessThanOrEqual(s.p99);
    expect(s.p99).toBeLessThanOrEqual(s.max);
  });

  it("merges histograms", () => {
    const a = new Histogram();
    const b = new Histogram();
    for (let i = 1; i <= 100; i++) (i % 2 ? a : b).record(i);
    a.merge(b);
    expect(a.count).toBe(100);
    expect(a.max).toBe(100);
    expect(a.min).toBe(1);
    expect(Math.abs(a.percentile(0.5) - 50) / 50).toBeLessThan(0.05);
  });

  it("clamps out-of-range values to edge buckets without losing them", () => {
    const h = new Histogram();
    h.record(1e-9);
    h.record(1e9);
    expect(h.count).toBe(2);
    expect(h.max).toBe(1e9);
  });
});
