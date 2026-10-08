#!/usr/bin/env node
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  type RunOptions,
  defaultOptions,
  parseDuration,
  parseSizes,
} from "./options";
import { renderBaseline, renderResult } from "./report";
import { type BenchResult, BenchResultSchema } from "./result-schema";
import { runBenchmark } from "./runner";
import { SCENARIOS } from "./scenarios/index";

const USAGE = `tila coordination benchmarks

Usage:
  pnpm bench -- [run] [options]        run scenarios, write JSON (and optional markdown)
  pnpm bench -- report --in <file|dir>... [--out <file>] [--title <t>]
  pnpm bench -- list

Run options:
  --tier inproc|embedded|http   (default inproc)
  --scenario <name>[,<name>]|all|mix   (default all)
  --participants N              virtual sessions (default 4)
  --principals K                distinct principals; http needs TILA_BENCH_TOKENS with K tokens
  --duration 30s  --warmup 5s   recorded window and warmup (time-based run)
  --iterations N                fixed iterations per participant instead of a duration
  --cadence 500ms               target period per iteration; missed deadlines are counted
  --mode exclusive|owner        claim mode for contended scenarios (default exclusive)
  --groups G                    disjoint hot resources in claims-contended (default 1)
  --hold-ms N                   hold time after winning a contended claim (default 0)
  --target tasks|records        fenced-writes target (default tasks)
  --steal-every N               fenced-writes thief cadence (default 5; 0 disables)
  --sizes 1k,64k,1m             artifact sizes
  --writers W                   journal-replay writer count (default ceil(N/2))
  --cold-start-iterations N     restart cycles for cold-start (default 5)
  --seed N                      PRNG seed (default 42)
  --out <file.json>             result path (default packages/bench/results/<tier>-<runId>.json)
  --md                          also write <out>.md next to the JSON
  --soak                        sample memory/store size every --sample-interval (default 30s)
  --sweep-every 10m             trigger the sweep periodically during a soak
  --region <text>               annotate the deployed region when it cannot be detected
  --quiet                       no progress output
  --allow-large                 permit >64 participants on the http tier

http tier environment: TILA_BASE_URL, TILA_TOKEN, TILA_PROJECT_ID, optional
TILA_BENCH_TOKENS (comma-separated, for --principals), SWEEP_SECRET, and
TILA_BENCH_ALLOW_REMOTE=1 for any non-localhost base URL.
`;

async function main(rawArgv: string[]): Promise<number> {
  // pnpm forwards a literal "--" separator (after the script's own args); drop it.
  const argv = rawArgv.filter((a) => a !== "--");
  const [first, ...rest] = argv;
  const sub = first && !first.startsWith("-") ? first : "run";
  const args = first && !first.startsWith("-") ? rest : argv;
  if (sub === "list") {
    for (const s of SCENARIOS)
      console.log(
        `${s.name.padEnd(20)} [${s.tiers.join(",")}]${s.explicitOnly ? " (explicit)" : ""}  ${s.description}`,
      );
    return 0;
  }
  if (sub === "report") return report(args);
  if (sub === "run") return run(args);
  console.error(USAGE);
  return 2;
}

async function run(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      help: { type: "boolean", short: "h" },
      tier: { type: "string" },
      scenario: { type: "string" },
      participants: { type: "string" },
      principals: { type: "string" },
      duration: { type: "string" },
      warmup: { type: "string" },
      iterations: { type: "string" },
      cadence: { type: "string" },
      mode: { type: "string" },
      groups: { type: "string" },
      "hold-ms": { type: "string" },
      target: { type: "string" },
      "steal-every": { type: "string" },
      sizes: { type: "string" },
      writers: { type: "string" },
      "cold-start-iterations": { type: "string" },
      seed: { type: "string" },
      out: { type: "string" },
      md: { type: "boolean" },
      soak: { type: "boolean" },
      "sample-interval": { type: "string" },
      "sweep-every": { type: "string" },
      region: { type: "string" },
      "base-url": { type: "string" },
      token: { type: "string" },
      project: { type: "string" },
      quiet: { type: "boolean" },
      "allow-large": { type: "boolean" },
    },
    strict: true,
  });
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  const env = process.env;
  const int = (v: string | undefined) =>
    v === undefined ? undefined : Number.parseInt(v, 10);
  const opts: RunOptions = defaultOptions({
    tier: (values.tier as RunOptions["tier"]) ?? "inproc",
    scenario: values.scenario ?? "all",
    participants: int(values.participants) ?? 4,
    principals: int(values.principals) ?? 1,
    durationMs: parseDuration(values.duration, 10_000),
    warmupMs: parseDuration(values.warmup, 1_000),
    iterations: int(values.iterations),
    cadenceMs: values.cadence ? parseDuration(values.cadence, 0) : undefined,
    params: {
      mode: (values.mode as "exclusive" | "owner") ?? "exclusive",
      groups: int(values.groups) ?? 1,
      holdMs: int(values["hold-ms"]) ?? 0,
      target: (values.target as "tasks" | "records") ?? "tasks",
      stealEvery: int(values["steal-every"]) ?? 5,
      sizesBytes: parseSizes(values.sizes),
      writers: int(values.writers),
      coldStartIterations: int(values["cold-start-iterations"]) ?? 5,
    },
    seed: int(values.seed) ?? 42,
    out: values.out,
    md: values.md ?? false,
    soak: values.soak ?? false,
    sampleIntervalMs: parseDuration(values["sample-interval"], 30_000),
    sweepEveryMs: values["sweep-every"]
      ? parseDuration(values["sweep-every"], 0)
      : undefined,
    sweepSecret: env.SWEEP_SECRET,
    region: values.region,
    baseUrl: values["base-url"] ?? env.TILA_BASE_URL,
    token: values.token ?? env.TILA_TOKEN,
    tokens: env.TILA_BENCH_TOKENS?.split(",")
      .map((t) => t.trim())
      .filter(Boolean),
    projectId: values.project ?? env.TILA_PROJECT_ID,
    allowRemote: env.TILA_BENCH_ALLOW_REMOTE === "1",
    allowLarge: values["allow-large"] ?? false,
    quiet: values.quiet ?? false,
  });
  if (
    opts.tier === "http" &&
    opts.tokens &&
    !opts.tokens.includes(opts.token ?? "")
  )
    opts.tokens = [opts.token as string, ...opts.tokens];

  const log = opts.quiet
    ? () => {}
    : (msg: string) => console.error(`[bench] ${msg}`);
  const controller = new AbortController();
  process.once("SIGINT", () => {
    log("interrupted; finishing the current window and writing results");
    controller.abort();
  });
  const result = await runBenchmark(opts, {
    log,
    signal: controller.signal,
    cwd: repoRoot(),
  });

  const outPath = path.resolve(
    opts.out ??
      path.join(
        repoRoot(),
        "packages/bench/results",
        `${opts.tier}-${result.run_id}.json`,
      ),
  );
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`);
  log(`wrote ${outPath}`);
  if (opts.md) {
    const mdPath = `${outPath.replace(/\.json$/, "")}.md`;
    writeFileSync(mdPath, renderResult(result));
    log(`wrote ${mdPath}`);
  }
  console.log(renderResult(result));
  const failed = result.scenarios.flatMap((s) =>
    s.invariants.filter((i) => !i.ok).map((i) => `${s.name}: ${i.name}`),
  );
  if (failed.length > 0) {
    console.error(`invariants failed:\n  ${failed.join("\n  ")}`);
    return 1;
  }
  return 0;
}

async function report(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      in: { type: "string", multiple: true },
      out: { type: "string" },
      title: { type: "string" },
    },
    strict: true,
  });
  const inputs = values.in ?? [];
  if (inputs.length === 0) {
    console.error("report: pass at least one --in <file.json|dir>");
    return 2;
  }
  const files = inputs.flatMap((p) => {
    const abs = path.resolve(p);
    if (statSync(abs).isDirectory())
      return readdirSync(abs)
        .filter((f) => f.endsWith(".json"))
        .map((f) => path.join(abs, f));
    return [abs];
  });
  const results: BenchResult[] = files.map((f) =>
    BenchResultSchema.parse(JSON.parse(readFileSync(f, "utf8"))),
  );
  const md = renderBaseline(results, values.title);
  if (values.out) {
    mkdirSync(path.dirname(path.resolve(values.out)), { recursive: true });
    writeFileSync(path.resolve(values.out), md);
    console.error(
      `wrote ${path.resolve(values.out)} from ${files.length} result(s)`,
    );
  } else {
    console.log(md);
  }
  return 0;
}

function repoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    try {
      if (statSync(path.join(dir, "pnpm-workspace.yaml")).isFile()) return dir;
    } catch {
      // keep walking
    }
    dir = path.dirname(dir);
  }
  return process.cwd();
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? `${err.message}` : String(err));
    process.exit(1);
  },
);
