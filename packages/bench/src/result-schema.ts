import { z } from "zod";

/** Bump on any change to metric semantics or the result layout. */
export const HARNESS_VERSION = "1.1.0";
export const SCHEMA_VERSION = 1;

const LatencySchema = z.object({
  p50: z.number(),
  p95: z.number(),
  p99: z.number(),
  max: z.number(),
  mean: z.number(),
});

export const TimingSummarySchema = z.object({
  requests: z.number().int().nonnegative(),
  timed_requests: z.number().int().nonnegative(),
  invalid_residuals: z.number().int().nonnegative(),
  metrics: z.record(
    LatencySchema.extend({ count: z.number().int().nonnegative() }),
  ),
  locations: z.record(z.number().int().nonnegative()),
});

export const MetricsSchema = z.object({
  timing: TimingSummarySchema.optional(),
  ops: z.number().int().nonnegative(),
  ok: z.number().int().nonnegative(),
  conflicts: z.number().int().nonnegative(),
  stale_fence: z.number().int().nonnegative(),
  errors: z.number().int().nonnegative(),
  error_rate: z.number().min(0).max(1),
  throughput_ops_s: z.number().nonnegative(),
  latency_ms: LatencySchema,
  error_samples: z.array(
    z.object({
      op: z.string(),
      status: z.number().optional(),
      code: z.string().optional(),
      message: z.string(),
    }),
  ),
});

export const ScenarioResultSchema = z.object({
  name: z.string(),
  description: z.string(),
  participants: z.number().int().nonnegative(),
  window_s: z.number().nonnegative(),
  dataset: z.record(z.unknown()),
  ops: z.record(MetricsSchema),
  totals: MetricsSchema,
  invariants: z.array(
    z.object({
      name: z.string(),
      ok: z.boolean(),
      detail: z.string().optional(),
    }),
  ),
  extra: z.record(z.number()),
});

export const SoakSampleSchema = z.object({
  t_ms: z.number().nonnegative(),
  rss_bytes: z.number().nonnegative(),
  heap_used_bytes: z.number().nonnegative(),
  db_bytes: z.number().nullable(),
  counts: z.record(z.number()).nullable(),
  sweep: z.record(z.number()).nullable(),
});

export const BenchResultSchema = z.object({
  harness_version: z.string(),
  schema_version: z.literal(SCHEMA_VERSION),
  run_id: z.string(),
  started_at: z.string(),
  finished_at: z.string(),
  git: z.object({ sha: z.string().nullable(), dirty: z.boolean().nullable() }),
  tier: z.enum(["inproc", "embedded", "http"]),
  target: z.object({
    base_url_host: z.string().optional(),
    deployed: z.boolean(),
    region: z
      .object({
        cf_colo: z.string().optional(),
        cf_placement: z.string().optional(),
        user: z.string().optional(),
      })
      .optional(),
    notes: z.array(z.string()),
  }),
  hardware: z.object({
    platform: z.string(),
    arch: z.string(),
    cpu_model: z.string(),
    cpu_count: z.number().int(),
    total_mem_bytes: z.number(),
    node_version: z.string(),
  }),
  params: z.object({
    scenario: z.string(),
    participants: z.number().int(),
    principals: z.number().int(),
    duration_ms: z.number().int(),
    warmup_ms: z.number().int(),
    iterations: z.number().int().nullable(),
    cadence_ms: z.number().int().nullable(),
    mode: z.enum(["exclusive", "owner"]),
    groups: z.number().int(),
    hold_ms: z.number().int(),
    target: z.enum(["tasks", "records"]),
    steal_every: z.number().int(),
    sizes_bytes: z.array(z.number().int()),
    writers: z.number().int().nullable(),
    cold_start_iterations: z.number().int(),
    seed: z.number().int(),
    soak: z.boolean(),
    sample_interval_ms: z.number().int().nullable(),
  }),
  scenarios: z.array(ScenarioResultSchema),
  soak: z
    .object({
      interval_ms: z.number().int(),
      samples: z.array(SoakSampleSchema),
    })
    .nullable(),
});

export type BenchResult = z.infer<typeof BenchResultSchema>;
export type ScenarioResult = z.infer<typeof ScenarioResultSchema>;
export type SoakSample = z.infer<typeof SoakSampleSchema>;
