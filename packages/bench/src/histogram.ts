/**
 * Log-linear latency histogram with no dependencies.
 *
 * Values are bucketed by octave (power of two) with SUB sub-buckets per
 * octave, so any percentile is accurate to within 1/SUB relative error
 * (about 3% at SUB = 32). Exact min, max, count and sum are kept alongside.
 * Covers ~1 µs to ~70 minutes; values outside clamp to the edge buckets.
 */
const SUB = 32;
const MIN_EXP = -10; // 2^-10 ms ≈ 1 µs
const MAX_EXP = 22; // 2^22 ms ≈ 70 min
const OCTAVES = MAX_EXP - MIN_EXP + 1;
const BUCKETS = OCTAVES * SUB;

export interface LatencySummary {
  p50: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
}

export class Histogram {
  private counts = new Uint32Array(BUCKETS);
  private _count = 0;
  private _sum = 0;
  private _min = Number.POSITIVE_INFINITY;
  private _max = 0;

  get count(): number {
    return this._count;
  }
  get max(): number {
    return this._count === 0 ? 0 : this._max;
  }
  get min(): number {
    return this._count === 0 ? 0 : this._min;
  }
  get mean(): number {
    return this._count === 0 ? 0 : this._sum / this._count;
  }

  record(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    this.counts[Histogram.index(ms)]++;
    this._count++;
    this._sum += ms;
    if (ms < this._min) this._min = ms;
    if (ms > this._max) this._max = ms;
  }

  merge(other: Histogram): void {
    for (let i = 0; i < BUCKETS; i++) this.counts[i] += other.counts[i];
    this._count += other._count;
    this._sum += other._sum;
    if (other._count > 0) {
      if (other._min < this._min) this._min = other._min;
      if (other._max > this._max) this._max = other._max;
    }
  }

  /** p in [0, 1]. Interpolates inside the matching bucket. */
  percentile(p: number): number {
    if (this._count === 0) return 0;
    if (p <= 0) return this._min;
    if (p >= 1) return this._max;
    const target = Math.max(1, Math.ceil(p * this._count));
    let cum = 0;
    for (let i = 0; i < BUCKETS; i++) {
      const n = this.counts[i];
      if (n === 0) continue;
      if (cum + n >= target) {
        const [lo, hi] = Histogram.bounds(i);
        const frac = (target - cum - 0.5) / n;
        const v = lo + (hi - lo) * Math.min(1, Math.max(0, frac));
        return Math.min(this._max, Math.max(this._min, v));
      }
      cum += n;
    }
    return this._max;
  }

  summary(): LatencySummary {
    return {
      p50: round(this.percentile(0.5)),
      p95: round(this.percentile(0.95)),
      p99: round(this.percentile(0.99)),
      max: round(this.max),
      mean: round(this.mean),
    };
  }

  static index(ms: number): number {
    if (ms <= 0) return 0;
    const e = Math.floor(Math.log2(ms));
    if (e < MIN_EXP) return 0;
    if (e > MAX_EXP) return BUCKETS - 1;
    const base = 2 ** e;
    const sub = Math.min(SUB - 1, Math.floor(((ms - base) / base) * SUB));
    return (e - MIN_EXP) * SUB + sub;
  }

  static bounds(index: number): [number, number] {
    const e = Math.floor(index / SUB) + MIN_EXP;
    const sub = index % SUB;
    const base = 2 ** e;
    return [base * (1 + sub / SUB), base * (1 + (sub + 1) / SUB)];
  }
}

function round(v: number): number {
  return Math.round(v * 1000) / 1000;
}
