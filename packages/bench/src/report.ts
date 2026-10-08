import type { Metrics } from "./recorder";
import type { BenchResult, ScenarioResult, SoakSample } from "./result-schema";

const fmt = (n: number, digits = 2) =>
  Number.isFinite(n) ? n.toFixed(digits).replace(/\.?0+$/, "") || "0" : "n/a";
const mib = (bytes: number) => `${(bytes / 1_048_576).toFixed(1)} MiB`;

function metricsRow(label: string, m: Metrics): string {
  const l = m.latency_ms;
  return `| ${label} | ${m.ops} | ${m.ok} | ${m.conflicts} | ${m.stale_fence} | ${m.errors} | ${fmt(m.throughput_ops_s)} | ${fmt(l.p50)} | ${fmt(l.p95)} | ${fmt(l.p99)} | ${fmt(l.max)} |`;
}

const METRICS_HEADER = [
  "| op | ops | ok | conflicts | stale fence | errors | ops/s | p50 ms | p95 ms | p99 ms | max ms |",
  "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
].join("\n");

export function renderRunHeader(r: BenchResult): string {
  const target = r.target.deployed
    ? `deployed (${r.target.base_url_host ?? "?"}${r.target.region?.cf_colo ? `, colo ${r.target.region.cf_colo}` : ""}${r.target.region?.cf_placement ? `, placement ${r.target.region.cf_placement}` : ""}${r.target.region?.user ? `, ${r.target.region.user}` : ""})`
    : r.tier === "http"
      ? `local Worker (${r.target.base_url_host ?? "?"})`
      : r.tier;
  const p = r.params;
  const rows = [
    ["Run", `\`${r.run_id}\` at ${r.started_at}`],
    ["Harness", `${r.harness_version} (schema ${r.schema_version})`],
    [
      "Git",
      `${r.git.sha ? r.git.sha.slice(0, 10) : "unknown"}${r.git.dirty ? " (dirty)" : ""}`,
    ],
    ["Tier / target", `${r.tier} / ${target}`],
    [
      "Hardware",
      `${r.hardware.cpu_model} × ${r.hardware.cpu_count}, ${mib(r.hardware.total_mem_bytes)} RAM, ${r.hardware.platform} ${r.hardware.arch}, node ${r.hardware.node_version}`,
    ],
    [
      "Load",
      `${p.participants} participants, ${p.principals} principal(s), ${p.iterations !== null ? `${p.iterations} iterations each` : `${fmt(p.duration_ms / 1000, 1)}s after ${fmt(p.warmup_ms / 1000, 1)}s warmup`}${p.cadence_ms !== null ? `, cadence ${p.cadence_ms} ms` : ""}`,
    ],
    [
      "Params",
      `mode ${p.mode}, groups ${p.groups}, hold ${p.hold_ms} ms, target ${p.target}, steal every ${p.steal_every}, sizes ${p.sizes_bytes.join("/")} B, seed ${p.seed}${p.soak ? `, soak sampling every ${p.sample_interval_ms} ms` : ""}`,
    ],
  ];
  return [
    "| | |",
    "|---|---|",
    ...rows.map(([k, v]) => `| **${k}** | ${v} |`),
  ].join("\n");
}

export function renderScenario(s: ScenarioResult): string {
  const lines: string[] = [];
  lines.push(`#### ${s.name}`);
  lines.push("");
  lines.push(
    `${s.description} ${s.participants} participant(s), ${fmt(s.window_s, 1)}s recorded.`,
  );
  if (Object.keys(s.dataset).length > 0)
    lines.push(
      `Dataset: ${Object.entries(s.dataset)
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .join(", ")}.`,
    );
  lines.push("");
  lines.push(METRICS_HEADER);
  for (const [op, m] of Object.entries(s.ops)) lines.push(metricsRow(op, m));
  lines.push(metricsRow("**total**", s.totals));
  lines.push("");
  if (Object.keys(s.extra).length > 0)
    lines.push(
      `Counters: ${Object.entries(s.extra)
        .map(([k, v]) => `${k}=${fmt(v)}`)
        .join(", ")}.`,
    );
  if (s.invariants.length > 0) {
    lines.push("");
    for (const inv of s.invariants)
      lines.push(
        `- ${inv.ok ? "PASS" : "FAIL"} ${inv.name}${inv.detail ? ` (${inv.detail})` : ""}`,
      );
  }
  if (s.totals.error_samples.length > 0) {
    lines.push("");
    lines.push("Error samples:");
    for (const e of s.totals.error_samples)
      lines.push(
        `- \`${e.op}\` ${e.status ?? ""} ${e.code ?? ""}: ${e.message}`,
      );
  }
  return lines.join("\n");
}

export function renderSoak(samples: SoakSample[], intervalMs: number): string {
  if (samples.length === 0) return "";
  const first = samples[0];
  const last = samples[samples.length - 1];
  const minutes = Math.max(1 / 60, (last.t_ms - first.t_ms) / 60_000);
  const keys = new Set<string>();
  for (const s of samples)
    for (const k of Object.keys(s.counts ?? {})) keys.add(k);
  const lines = [
    `Soak: ${samples.length} samples every ${fmt(intervalMs / 1000, 0)}s over ${fmt(minutes, 1)} min.`,
    "",
    "| series | first | last | max | growth/min |",
    "|---|---:|---:|---:|---:|",
    `| rss | ${mib(first.rss_bytes)} | ${mib(last.rss_bytes)} | ${mib(Math.max(...samples.map((s) => s.rss_bytes)))} | ${mib((last.rss_bytes - first.rss_bytes) / minutes)} |`,
  ];
  if (first.db_bytes !== null && last.db_bytes !== null)
    lines.push(
      `| db_bytes | ${mib(first.db_bytes)} | ${mib(last.db_bytes)} | ${mib(Math.max(...samples.map((s) => s.db_bytes ?? 0)))} | ${mib((last.db_bytes - first.db_bytes) / minutes)} |`,
    );
  for (const k of [...keys].sort()) {
    const series = samples.map((s) => s.counts?.[k] ?? 0);
    lines.push(
      `| ${k} | ${series[0]} | ${series[series.length - 1]} | ${Math.max(...series)} | ${fmt((series[series.length - 1] - series[0]) / minutes, 1)} |`,
    );
  }
  const sweeps = samples.filter((s) => s.sweep);
  if (sweeps.length > 0) {
    lines.push("");
    lines.push(`Sweeps: ${sweeps.length}.`);
    for (const s of sweeps)
      lines.push(
        `- t=${fmt(s.t_ms / 1000, 0)}s ${Object.entries(s.sweep ?? {})
          .map(([k, v]) => `${k}=${fmt(v)}`)
          .join(", ")}`,
      );
  }
  return lines.join("\n");
}

/** Full markdown for one result file. */
export function renderResult(r: BenchResult): string {
  const parts = [renderRunHeader(r), ""];
  for (const s of r.scenarios) parts.push(renderScenario(s), "");
  if (r.soak) parts.push(renderSoak(r.soak.samples, r.soak.interval_ms), "");
  return parts.join("\n").trimEnd().concat("\n");
}

/** Baseline document: one section per result, newest first. */
export function renderBaseline(
  results: BenchResult[],
  title = "Benchmark baseline",
): string {
  const sorted = [...results].sort((a, b) =>
    b.started_at.localeCompare(a.started_at),
  );
  const parts = [
    `# ${title}`,
    "",
    "Generated by `pnpm bench:report` from raw harness output (see docs/benchmarks/README.md for methodology and what each tier measures). Latencies are per facade call, measured by the harness around the SDK method; throughput counts every recorded sub-operation across all participants. Conflicts and stale-fence rejections are expected outcomes and are excluded from the error rate.",
    "",
  ];
  for (const r of sorted) {
    parts.push(
      `## ${r.tier}${r.target.deployed ? " deployed" : ""}: ${r.params.scenario} (${r.run_id})`,
      "",
    );
    parts.push(renderResult(r));
  }
  return parts.join("\n").trimEnd().concat("\n");
}
