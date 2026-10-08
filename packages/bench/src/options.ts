import { z } from "zod";
import type { ScenarioParams, Tier } from "./types";

export const TIERS = ["inproc", "embedded", "http"] as const;

export interface RunOptions {
  tier: Tier;
  scenario: string;
  participants: number;
  principals: number;
  durationMs: number;
  warmupMs: number;
  /** Fixed iterations per participant instead of a time budget. */
  iterations?: number;
  cadenceMs?: number;
  params: ScenarioParams;
  seed: number;
  out?: string;
  md: boolean;
  soak: boolean;
  sampleIntervalMs: number;
  sweepEveryMs?: number;
  sweepSecret?: string;
  region?: string;
  baseUrl?: string;
  token?: string;
  /** Extra tokens for `--principals > 1` on the http tier (one per principal). */
  tokens?: string[];
  projectId?: string;
  allowRemote: boolean;
  allowLarge: boolean;
  quiet: boolean;
}

/** "30s", "2h", "500ms", "90" (ms) → milliseconds. */
export function parseDuration(
  input: string | undefined,
  fallbackMs: number,
): number {
  if (input === undefined || input === "") return fallbackMs;
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(input.trim());
  if (!m)
    throw new Error(`Invalid duration "${input}" (use 500ms, 30s, 5m, 2h)`);
  const n = Number(m[1]);
  const unit = m[2] ?? "ms";
  const mult =
    unit === "h" ? 3_600_000 : unit === "m" ? 60_000 : unit === "s" ? 1000 : 1;
  return Math.round(n * mult);
}

/** "1k,64k,1m" → bytes. */
export function parseSizes(input: string | undefined): number[] {
  if (!input) return [1024, 65_536, 1_048_576];
  return input.split(",").map((raw) => {
    const m = /^(\d+)(k|m|b)?$/i.exec(raw.trim());
    if (!m) throw new Error(`Invalid size "${raw}" (use 1k, 64k, 1m)`);
    const n = Number(m[1]);
    const unit = (m[2] ?? "b").toLowerCase();
    return unit === "m" ? n * 1_048_576 : unit === "k" ? n * 1024 : n;
  });
}

const positiveInt = z.number().int().positive();

export const RunOptionsSchema = z.object({
  tier: z.enum(TIERS),
  scenario: z.string().min(1),
  participants: positiveInt.max(10_000),
  principals: positiveInt,
  durationMs: positiveInt,
  warmupMs: z.number().int().nonnegative(),
  iterations: positiveInt.optional(),
  cadenceMs: positiveInt.optional(),
  params: z.object({
    mode: z.enum(["exclusive", "owner"]),
    groups: positiveInt,
    holdMs: z.number().int().nonnegative(),
    target: z.enum(["tasks", "records"]),
    stealEvery: z.number().int().nonnegative(),
    sizesBytes: z.array(positiveInt).min(1),
    writers: positiveInt.optional(),
    coldStartIterations: positiveInt,
  }),
  seed: z.number().int(),
  out: z.string().optional(),
  md: z.boolean(),
  soak: z.boolean(),
  sampleIntervalMs: positiveInt,
  sweepEveryMs: positiveInt.optional(),
  sweepSecret: z.string().optional(),
  region: z.string().optional(),
  baseUrl: z.string().optional(),
  token: z.string().optional(),
  tokens: z.array(z.string()).optional(),
  projectId: z.string().optional(),
  allowRemote: z.boolean(),
  allowLarge: z.boolean(),
  quiet: z.boolean(),
});

export function defaultParams(): ScenarioParams {
  return {
    mode: "exclusive",
    groups: 1,
    holdMs: 0,
    target: "tasks",
    stealEvery: 5,
    sizesBytes: parseSizes(undefined),
    coldStartIterations: 5,
  };
}

export type RunOptionsInput = Partial<Omit<RunOptions, "params">> & {
  params?: Partial<ScenarioParams>;
};

export function defaultOptions(partial: RunOptionsInput = {}): RunOptions {
  return RunOptionsSchema.parse({
    tier: "inproc",
    scenario: "all",
    participants: 4,
    principals: 1,
    durationMs: 10_000,
    warmupMs: 1_000,
    seed: 42,
    md: false,
    soak: false,
    sampleIntervalMs: 30_000,
    allowRemote: false,
    allowLarge: false,
    quiet: false,
    ...partial,
    params: { ...defaultParams(), ...partial.params },
  });
}
