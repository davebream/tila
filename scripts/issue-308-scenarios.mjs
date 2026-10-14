import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const runtime = (files) => [
  "pnpm",
  "--filter",
  "@tila/integration-tests",
  "exec",
  "vitest",
  "run",
  "--config",
  "vitest.runtime.config.ts",
  ...files.map((f) => `runtime/${f}.test.ts`),
];
export const checks = [
  {
    scenario: "S1",
    step: "protocol-validator",
    provenance: "unit/fixture",
    command: ["node", "--test", "scripts/issue-308-scenarios.test.mjs"],
  },
  {
    scenario: "S1",
    step: "build-foundations",
    provenance: "unit/fixture",
    command: ["pnpm", "build"],
  },
  {
    scenario: "S1",
    step: "ui-foundations-s1-s3",
    provenance: "unit/fixture",
    command: ["pnpm", "--filter", "@tila/ui", "test"],
  },
  {
    scenario: "S1",
    step: "ui-typecheck",
    provenance: "unit/fixture",
    command: ["pnpm", "--filter", "@tila/ui", "typecheck"],
  },
  {
    scenario: "S1",
    step: "runtime-typecheck",
    provenance: "unit/fixture",
    command: ["pnpm", "--filter", "@tila/integration-tests", "typecheck"],
  },
  {
    scenario: "S1",
    step: "bootstrap-revision-definition-fixtures",
    provenance: "local Cloudflare runtime",
    command: runtime([
      "project-bootstrap",
      "definition-editor",
      "definition-transfer",
      "schema-revision",
      "settings-identities",
      "settings-access",
      "service-identity-revisions",
      "settings-restore",
      "product-scenarios",
    ]),
  },
  {
    scenario: "S2",
    step: "durable-question-authority-fixtures",
    provenance: "local Cloudflare runtime",
    command: runtime([
      "attempts",
      "attempt-authority",
      "attempt-continuity",
      "questions",
      "question-api",
      "agent-bindings",
      "artifacts",
    ]),
  },
  {
    scenario: "S3",
    step: "correction-audit-readiness-fixtures",
    provenance: "local Cloudflare runtime",
    command: runtime([
      "attempt-corrections",
      "readiness",
      "recovery",
      "runtime-view",
      "task-filter-pages",
    ]),
  },
  {
    scenario: "S3",
    step: "required-runtime-gate-s1-s3",
    provenance: "local Cloudflare runtime",
    command: ["pnpm", "test:runtime"],
  },
];

export function sanitize(log, workspace = root) {
  return (
    log
      // biome-ignore lint/suspicious/noControlCharactersInRegex: remove ANSI terminal color escapes from captured test logs.
      .replace(/\x1b\[[0-9;]*m/g, "")
      .replaceAll(workspace, "<checkout>")
      .replace(
        /(?:\/home\/|\/Users\/|[A-Z]:\\Users\\)[^\s"'<>]+/g,
        "<local-path>",
      )
      .replace(/\bBearer\s+[^\s"']+/gi, "Bearer <redacted>")
      .replace(/\btila_(?:s\.)?[A-Za-z0-9._-]+/g, "<credential-redacted>")
      .replace(
        /((?:api[_-]?key|password|secret|authorization|access[_-]?token)\s*[=:]\s*)[^\s,;]+/gi,
        "$1<redacted>",
      )
  );
}

const provenances = [
  "unit/fixture",
  "local Cloudflare runtime",
  "isolated host probe",
  "authenticated live",
];
export function validateObservation(o) {
  for (const field of [
    "id",
    "scenario",
    "step",
    "provenance",
    "result",
    "candidate_sha",
    "release",
    "migrations",
    "environment",
    "timestamps",
    "artifact_refs",
    "blocker_owner",
    "source_sha256",
    "measurements",
  ])
    assert.ok(Object.hasOwn(o, field), `Missing ${field}`);
  assert.match(o.id, /^[a-zA-Z0-9-]+$/);
  assert.ok(["S1", "S2", "S3"].includes(o.scenario));
  assert.ok(typeof o.step === "string" && o.step.length > 0);
  assert.ok(provenances.includes(o.provenance), "Invalid provenance");
  assert.ok(["passed", "failed", "blocked", "not-run"].includes(o.result));
  assert.match(o.candidate_sha, /^[a-f0-9]{40}$/);
  assert.match(o.source_sha256, /^[a-f0-9]{64}$/);
  assert.match(o.release, /^\d+\.\d+\.\d+/);
  for (const field of [
    "os",
    "arch",
    "node",
    "pnpm",
    "profiles",
    "runtime_versions",
  ])
    assert.ok(o.environment[field], `Missing environment.${field}`);
  for (const group of ["do", "d1", "configuration"])
    assert.ok(o.migrations[group]?.length > 0, `Missing migrations.${group}`);
  assert.ok(o.migrations.scope);
  for (const stamp of [o.timestamps.started_at, o.timestamps.finished_at])
    assert.ok(
      typeof stamp === "string" && Number.isFinite(Date.parse(stamp)),
      "Invalid timestamp",
    );
  assert.ok(
    Date.parse(o.timestamps.finished_at) >= Date.parse(o.timestamps.started_at),
  );
  assert.ok(Array.isArray(o.artifact_refs) && o.artifact_refs.length > 0);
  for (const ref of [
    ...o.artifact_refs,
    ...Object.values(o.migrations).filter(Array.isArray).flat(),
  ]) {
    assert.ok(
      !ref.path.startsWith("/") &&
        !ref.path.includes("..") &&
        !ref.path.includes("\\"),
      "Artifact path must be relative",
    );
    assert.match(ref.sha256, /^[a-f0-9]{64}$/);
  }
  if (["failed", "blocked", "not-run"].includes(o.result)) {
    assert.ok(
      typeof o.blocker_owner === "string" && o.blocker_owner.length > 0,
    );
    assert.ok(typeof o.reason === "string" && o.reason.length > 0);
  } else assert.equal(o.blocker_owner, null);
  for (const metric of [
    "setup_steps",
    "setup_ms",
    "diagnosis_ms",
    "recovery_ms",
    "duplicates",
    "lost_decisions",
    "stale_writes_rejected",
    "interventions",
  ])
    assert.ok(Object.hasOwn(o.measurements, metric));
  return o;
}

export function verifyArtifacts(report, base = root) {
  for (const observation of report.observations) {
    validateObservation(observation);
    for (const ref of observation.artifact_refs) {
      const path = resolve(base, ref.path);
      assert.ok(path.startsWith(`${resolve(base)}${sep}`));
      assert.equal(
        hash(readFileSync(path)),
        ref.sha256,
        `Checksum mismatch: ${ref.path}`,
      );
    }
  }
}

const git = (...args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const isEvidence = (path) => path.startsWith("docs/evidence/issue-308-");
export function metadata() {
  const changes = git("status", "--porcelain", "--untracked-files=all")
    .split("\n")
    .filter(Boolean);
  assert.ok(
    changes.every((line) => isEvidence(line.slice(3))),
    "Commit source before recording evidence",
  );
  const paths = git("ls-files").split("\n").sort();
  const source = paths.filter((p) => !p.startsWith("docs/evidence/"));
  const ref = (path) => ({
    path,
    sha256: hash(readFileSync(resolve(root, path))),
  });
  const version = (path) =>
    JSON.parse(readFileSync(resolve(root, path), "utf8")).version;
  const localRequire = createRequire(
    resolve(root, "packages/integration-tests/package.json"),
  );
  const installedVersion = (name) => {
    try {
      const resolver =
        name === "miniflare" || name === "workerd"
          ? createRequire(localRequire.resolve("@cloudflare/vitest-plugin"))
          : localRequire;
      const packagePath = resolver.resolve(`${name}/package.json`);
      return JSON.parse(readFileSync(packagePath, "utf8")).version;
    } catch {
      return "unavailable (dependency not installed/resolvable)";
    }
  };
  return {
    candidate_sha: git("rev-parse", "HEAD"),
    release: version("package.json"),
    source_sha256: hash(source.map((p) => `${p}\0${ref(p).sha256}\n`).join("")),
    migrations: {
      scope:
        "Local test setup only; no deployed migration observation. D1 setup applies global files; ProjectDO applies DO files; R2 is ephemeral.",
      do: paths
        .filter((p) => /^packages\/worker\/migrations\/do\/.*\.sql$/.test(p))
        .map(ref),
      d1: paths
        .filter((p) =>
          /^packages\/worker\/migrations\/global\/.*\.sql$/.test(p),
        )
        .map(ref),
      configuration: [
        "packages/worker/wrangler.toml",
        "packages/integration-tests/vitest.runtime.config.ts",
        "packages/integration-tests/runtime/setup.ts",
      ].map(ref),
    },
    environment: {
      os: process.platform,
      arch: process.arch,
      node: process.version,
      pnpm: execFileSync("pnpm", ["--version"], { encoding: "utf8" }).trim(),
      profiles:
        "Synthetic local test identities only; no native profiles or deployed credentials",
      runtime_versions: Object.fromEntries(
        ["vitest", "@cloudflare/vitest-plugin", "miniflare", "workerd"].map(
          (p) => [p, installedVersion(p)],
        ),
      ),
      dataset:
        "Predeclared in docs/issue-308-protocol.md; suite timings are validation cost, not usability measurements",
    },
    historical_refs: [
      "docs/evidence/issue-283-acceptance-v3.json",
      "docs/evidence/issue-283-herdr-0-9-3-v2.json",
    ].map(ref),
  };
}

export function execute(command) {
  return new Promise((done) => {
    // All commands are fixed local test commands. Remove credential environment
    // overrides so a developer shell cannot silently introduce a live identity.
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !/TOKEN|SECRET|PASSWORD|API_KEY|CREDENTIAL/i.test(key),
      ),
    );
    const child = spawn(command[0], command.slice(1), {
      cwd: root,
      env: { ...env, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let log = "";
    child.stdout.on("data", (bytes) => {
      log += bytes;
    });
    child.stderr.on("data", (bytes) => {
      log += bytes;
    });
    child.on("error", (error) => {
      log += `${error.message}\n`;
    });
    child.on("close", (code, signal) => done({ code: code ?? 1, log, signal }));
  });
}

export async function runChecks({
  base = root,
  output,
  context,
  previous = null,
  run = execute,
  selected = checks,
  onProgress = () => {},
}) {
  const report = {
    schema_version: 1,
    issue: 308,
    scope: "Protocol/local fixture preparation; no live acceptance",
    ...context,
    previous_run: previous
      ? { path: previous.path, sha256: hash(previous.bytes) }
      : null,
    observations: [],
  };
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`;
  const directory = resolve(base, output, runId);
  mkdirSync(directory, { recursive: true });
  writeFileSync(resolve(directory, "observations.jsonl"), "", { flag: "wx" });
  const measurements = Object.fromEntries(
    [
      "setup_steps",
      "setup_ms",
      "diagnosis_ms",
      "recovery_ms",
      "duplicates",
      "lost_decisions",
      "stale_writes_rejected",
      "interventions",
    ].map((m) => [m, null]),
  );
  const save = (check, startedAt, result, log, extra) => {
    const path = resolve(
      directory,
      `${report.observations.length + 1}-${check.step}.log`,
    );
    const sanitized = sanitize(log, base);
    writeFileSync(path, sanitized, { flag: "wx" });
    const observation = validateObservation({
      ...check,
      ...context,
      id: `${runId}-${report.observations.length + 1}`,
      result,
      timestamps: {
        started_at: startedAt,
        finished_at: new Date().toISOString(),
      },
      artifact_refs: [{ path: relative(base, path), sha256: hash(sanitized) }],
      blocker_owner: result === "passed" ? null : `#308 / ${check.step}`,
      measurements,
      rerun_of:
        previous?.report.observations
          .filter((o) => o.scenario === check.scenario && o.step === check.step)
          .map((o) => o.id) ?? [],
      ...extra,
    });
    appendFileSync(
      resolve(directory, "observations.jsonl"),
      `${JSON.stringify(observation)}\n`,
    );
    report.observations.push(observation);
    onProgress(`${check.scenario} ${check.step}: ${result}`);
  };
  for (const check of selected) {
    const started = new Date().toISOString();
    onProgress(`${check.scenario} ${check.step}: running`);
    let outcome;
    try {
      outcome = await run(check.command);
    } catch (error) {
      outcome = { code: 1, log: String(error) };
    }
    save(
      check,
      started,
      outcome.code === 0 ? "passed" : "failed",
      outcome.log,
      {
        exit_code: outcome.code,
        signal: outcome.signal ?? null,
        ...(outcome.code === 0
          ? {}
          : {
              reason:
                "Local validation command failed; retain log and link any rerun",
            }),
      },
    );
  }
  for (const [scenario, step, owner, reason] of [
    [
      "S1",
      "full-settings-transfer",
      "#448 / #308",
      "Integrated mapped settings transfer is not merged; full S1 remains blocked",
    ],
    [
      "S2",
      "authenticated-native-journey",
      "#283 / #308",
      "Both real host directions, independent accounts, outage, draft and replacement acceptance remain unexecuted",
    ],
    [
      "S3",
      "authenticated-hotfix-journey",
      "#307 / #308",
      "Authenticated browser/race/audit journey and operational readiness/activation disposition remain unexecuted",
    ],
  ])
    save(
      { scenario, step, provenance: "unit/fixture", command: null },
      new Date().toISOString(),
      "blocked",
      `${reason}\nThis is a prerequisite declaration, not an executed journey.\n`,
      { blocker_owner: owner, reason },
    );
  verifyArtifacts(report, base);
  writeFileSync(
    resolve(directory, "report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    { flag: "wx" },
  );
  return {
    report,
    path: relative(base, resolve(directory, "report.json")),
    failed: report.observations.some((o) => o.result === "failed"),
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--list") {
    for (const check of checks)
      console.log(
        `${check.scenario} ${check.step}: ${check.command.join(" ")}`,
      );
    return;
  }
  assert.equal(
    args.shift(),
    "--run",
    "Use --list or --run --output <evidence-root> [--previous <report>]",
  );
  assert.equal(args.shift(), "--output");
  const output = args.shift();
  assert.ok(
    [".ci-reports/issue-308", "docs/evidence/issue-308-local"].includes(output),
    "Use a declared local evidence root",
  );
  let previous = null;
  if (args.length) {
    assert.equal(args.shift(), "--previous");
    const path = args.shift();
    assert.ok(
      path &&
        !path.includes("..") &&
        [".ci-reports/issue-308/", "docs/evidence/issue-308-local/"].some((p) =>
          path.startsWith(p),
        ),
    );
    const bytes = readFileSync(resolve(root, path));
    const report = JSON.parse(bytes);
    verifyArtifacts(report);
    previous = { path, bytes, report };
  }
  assert.equal(args.length, 0, "Unexpected arguments");
  const result = await runChecks({
    output,
    context: metadata(),
    previous,
    onProgress: console.log,
  });
  console.log(`Evidence: ${result.path}`);
  if (result.failed) process.exitCode = 1;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch((error) => {
    console.error(sanitize(error.stack ?? String(error)));
    process.exitCode = 1;
  });
