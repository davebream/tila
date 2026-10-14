#!/usr/bin/env node
/**
 * Operator-side driver for the #194 pilot. It imports the fixtures module, which holds the
 * frozen acceptance cases and reference solutions, so it must never be given to a worker.
 * Worker-facing entry points live in dogfood-study-tila.mjs.
 *
 *   allocate | declare | manifest-check | drill | freeze | prepare | record | evaluate | derive | validate
 *
 * See docs/14-DOGFOOD-STUDY-PROTOCOL.md for the run procedure. Nothing here launches an agent.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { cpus, loadavg, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ACCEPT_RUNNER_SOURCE,
  allScenarios,
  allowedPaths,
  buildScenario,
  factSheet,
  handoffCandidates,
  materializeFiles,
  renderDecisionMessage,
  renderEntryPacket,
  renderWorkerPacket,
  resumeDecisionCandidate,
  warmupScenario,
} from "./dogfood-study-fixtures.mjs";
import {
  allocateVariants,
  appendEvent,
  auditJournal,
  buildDeclaration,
  buildHookSettings,
  canonicalJson,
  checkDeclaration,
  checkMatching,
  deriveLedger,
  parseEvents,
  sha256Text,
  studyCliEnv,
  validateBundle,
} from "./dogfood-study-lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const RUBRIC_REL = "docs/evidence/issue-194-rubric-v3.json";
const DECL_REL = "docs/evidence/issue-194-manifest-v3.json";
const TSX = join(repoRoot, "node_modules/.bin/tsx");

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const writeJson = (path, value) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
};

function parseArgs(argv) {
  const opts = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) opts[a.slice(2)] = true;
    else {
      opts[a.slice(2)] = next;
      i += 1;
    }
  }
  return { opts, positional };
}

function study(opts) {
  const rubricPath = resolve(repoRoot, opts.rubric ?? RUBRIC_REL);
  const rubricText = readFileSync(rubricPath, "utf8");
  return {
    rubric: JSON.parse(rubricText),
    rubricSha256: sha256Text(rubricText),
    rubricRel: opts.rubric ?? RUBRIC_REL,
    declPath: resolve(repoRoot, opts.declaration ?? DECL_REL),
    scenarios: [...allScenarios(), warmupScenario()],
  };
}

function fail(message, code = 1) {
  console.error(message);
  process.exit(code);
}

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

const GIT_ID = [
  "-c",
  "user.name=study",
  "-c",
  "user.email=study@example.invalid",
];

// ---------------------------------------------------------------------------
// Fixture validity: the evaluator must discriminate before anything is frozen.
// ---------------------------------------------------------------------------

function runAccept(root, tree, cases) {
  const casesFile = join(root, "cases.json");
  writeFileSync(casesFile, JSON.stringify(cases));
  const runner = join(root, "accept.mjs");
  writeFileSync(runner, ACCEPT_RUNNER_SOURCE);
  const out = spawnSync("node", [runner, tree, casesFile], {
    encoding: "utf8",
  });
  return JSON.parse(out.stdout).results;
}

function checkFixtures(scenarios) {
  const findings = [];
  const root = mkdtempSync(join(tmpdir(), "dogfood-fixture-"));
  try {
    for (const s of scenarios) {
      const tree = (name, extra = {}) => {
        const dir = join(root, `${s.id}-${name}`);
        materializeFiles({ ...s.repoFiles, ...extra }, dir);
        return dir;
      };
      const refs = (r) => ({ ...r.helper, ...r.item1, ...r.item2 });
      const base = runAccept(root, tree("base"), s.cases);
      const amended = runAccept(
        root,
        tree("am", refs(s.reference.amended)),
        s.cases,
      );
      const original = runAccept(
        root,
        tree("og", refs(s.reference.original)),
        s.cases,
      );
      // A constant-sample implementation (ignores its argument) must be caught for each item.
      const mutant = runAccept(
        root,
        tree("mut", {
          ...s.reference.amended.helper,
          ...s.mutant.item1,
          ...s.mutant.item2,
        }),
        s.cases,
      );
      const bad = (msg) =>
        findings.push({
          code: "fixture",
          severity: "error",
          message: `${s.id}: ${msg}`,
        });
      if (base.some((r) => r.pass))
        bad("baseline already passes an acceptance case");
      if (amended.some((r) => !r.pass))
        bad("amended reference fails an acceptance case");
      for (const item of ["item1", "item2"]) {
        if (!mutant.some((r, i) => !r.pass && s.cases[i].tags.includes(item)))
          bad(`a constant-sample ${item} passes every ${item} case`);
      }
      const d1 = (i) => s.cases[i].tags.includes(s.decision.id);
      original.forEach((r, i) => {
        if (d1(i) === r.pass)
          bad(
            `original-decision reference ${d1(i) ? "passes" : "fails"} "${s.cases[i].name}"`,
          );
      });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function cmdAllocate(opts) {
  const { rubric } = study(opts);
  const pairs = rubric.design.pairs.map((p) => p.pair);
  console.log(
    JSON.stringify(
      {
        seed: rubric.design.allocation.seed,
        pairs: allocateVariants(rubric.design.allocation.seed, pairs),
      },
      null,
      2,
    ),
  );
}

function cmdDeclare(opts) {
  const { rubric, rubricSha256, rubricRel, declPath, scenarios } = study(opts);
  const declaration = buildDeclaration({
    rubric,
    rubricSha256,
    rubricPath: rubricRel,
    scenarios: scenarios.filter((s) => s.pair !== "warmup"),
    warmup: scenarios.find((s) => s.pair === "warmup"),
  });
  writeJson(opts.out ?? declPath, declaration);
  console.log(`declaration written: ${declaration.declaration_sha256}`);
}

function manifestFindings(opts) {
  const { rubric, rubricSha256, rubricRel, declPath, scenarios } = study(opts);
  const scored = scenarios.filter((s) => s.pair !== "warmup");
  const declaration = readJson(declPath);
  const findings = [
    ...checkDeclaration(declaration, {
      rubric,
      rubricSha256,
      rubricPath: rubricRel,
      scenarios: scored,
      warmup: scenarios.find((s) => s.pair === "warmup"),
    }),
    ...checkMatching(scenarios),
    ...checkFixtures(scenarios),
  ];
  return { findings, declaration };
}

function cmdManifestCheck(opts) {
  const { findings } = manifestFindings(opts);
  console.log(JSON.stringify({ ok: findings.length === 0, findings }, null, 2));
  process.exit(findings.length ? 1 : 0);
}

function sdkCall(storeFile, participant, verb, ...args) {
  const out = spawnSync(
    TSX,
    [
      "--tsconfig",
      join(repoRoot, "tsconfig.json"),
      join(here, "dogfood-study-sdk.ts"),
      storeFile,
      participant,
      verb,
      ...args,
    ],
    { encoding: "utf8", cwd: repoRoot },
  );
  try {
    return JSON.parse(out.stdout.trim().split("\n").pop());
  } catch {
    return {
      ok: false,
      error: {
        kind: "error",
        message: (out.stderr || out.stdout).slice(0, 300),
      },
    };
  }
}

function cliCall(cwd, participant, args, config) {
  const out = spawnSync(
    "bun",
    [
      "--tsconfig-override",
      join(repoRoot, "tsconfig.json"),
      join(repoRoot, "packages/cli/src/index.ts"),
      ...args,
      "--json",
    ],
    {
      encoding: "utf8",
      cwd,
      env: studyCliEnv(participant, config?.machine_label ?? "study-host"),
    },
  );
  const text =
    (out.stdout || out.stderr)
      .split("\n")
      .filter((l) => l && !l.includes("directory mismatch"))
      .pop() ?? "";
  try {
    return JSON.parse(text);
  } catch {
    return { ok: false, error: { kind: "error", message: text.slice(0, 200) } };
  }
}

function writeLocalConfig(dir, store, version) {
  mkdirSync(join(dir, ".tila"), { recursive: true });
  writeFileSync(
    join(dir, ".tila/config.toml"),
    [
      `project_id = "${store.project}"`,
      'backend = "local"',
      "schema_version = 1",
      `tila_version = "${version}"`,
      'created_at = "2026-10-14T00:00:00.000Z"',
      "",
      "[local]",
      `db_path = "${store.dbPath}"`,
      `artifacts_path = "${store.artifactsPath}"`,
      `org = "${store.org}"`,
      "",
    ].join("\n"),
  );
}

/** Preflight mechanism drills on a scratch store. harness_fixture only; never an agent outcome. */
function cmdDrill(opts) {
  if (!opts["scratch-dir"] || !opts.out)
    fail("drill needs --scratch-dir and --out");
  const root = resolve(opts["scratch-dir"]);
  if (existsSync(root) && readdirSync(root).length)
    fail("scratch dir must be empty");
  mkdirSync(root, { recursive: true });
  const version = readJson(join(repoRoot, "package.json")).version;
  const store = {
    dbPath: join(root, "state/project.db"),
    artifactsPath: join(root, "state/artifacts"),
    org: "drill",
    project: "drill",
  };
  mkdirSync(join(root, "state"), { recursive: true });
  const storeFile = join(root, "store.json");
  writeJson(storeFile, store);
  const wt = join(root, "wt");
  writeLocalConfig(wt, store, version);
  const results = [];
  const record = (id, pass, observations) =>
    results.push({ id, pass, observations });

  const made = cliCall(wt, "orch", ["task", "new", "drill task"]);
  const taskId = made.result?.id;
  const resource = `task:${taskId}`;

  // D1: one winner under a simultaneous exclusive claim, as the SDK facade reports it.
  const racers = ["w1", "w2"].map(
    (p) =>
      new Promise((done) => {
        const proc = spawn(
          TSX,
          [
            "--tsconfig",
            join(repoRoot, "tsconfig.json"),
            join(here, "dogfood-study-sdk.ts"),
            storeFile,
            p,
            "claim",
            resource,
            "--ttl-ms",
            "60000",
          ],
          { cwd: repoRoot },
        );
        let out = "";
        proc.stdout.on("data", (d) => {
          out += d;
        });
        proc.on("close", () => {
          done({
            participant: p,
            result: JSON.parse(out.trim().split("\n").pop()),
          });
        });
      }),
  );
  Promise.all(racers).then(async (claims) => {
    const winners = claims.filter((c) => c.result.ok);
    const losers = claims.filter((c) => !c.result.ok);
    record(
      "D1_exclusive_claim",
      winners.length === 1 &&
        losers.length === 1 &&
        losers[0].result.error.kind === "already-held",
      {
        winners: winners.map((w) => ({
          participant: w.participant,
          fence: w.result.fence,
        })),
        loser_error_kind: losers[0]?.result.error?.kind,
      },
    );
    // Known limitation KL-cli-claim-report: record what the CLI says to a losing claimant.
    const loser = losers[0]?.participant ?? "w2";
    const cli = cliCall(wt, loser, ["task", "claim", taskId]);
    record("D1b_cli_task_claim_report", true, {
      known_limitation: "KL-cli-claim-report",
      cli_reported_loser_as_acquired:
        cli.ok === true && cli.result?.acquired === true,
      not_used_as_acquisition_evidence: true,
    });

    // D2: an old fence is rejected after a newer acquisition; state and journal stay unchanged.
    const shortId = cliCall(wt, "orch", ["task", "new", "drill stale"]).result
      ?.id;
    const shortRes = `task:${shortId}`;
    const first = sdkCall(storeFile, "w1", "claim", shortRes, "--ttl-ms", "1");
    await new Promise((r) => setTimeout(r, 30));
    const second = sdkCall(
      storeFile,
      "w2",
      "claim",
      shortRes,
      "--ttl-ms",
      "60000",
    );
    const before = auditJournal(
      sdkCall(storeFile, "evaluator", "journal-dump").events ?? [],
    );
    const stale = cliCall(wt, "w1", [
      "task",
      "update",
      shortId,
      "--field",
      "status=stale",
      "--fence",
      String(first.fence),
    ]);
    const fresh = cliCall(wt, "w2", [
      "task",
      "update",
      shortId,
      "--field",
      "status=fresh",
      "--fence",
      String(second.fence),
    ]);
    const shown = cliCall(wt, "w2", ["task", "show", shortId]);
    const after = auditJournal(
      sdkCall(storeFile, "evaluator", "journal-dump").events ?? [],
    );
    record(
      "D2_stale_fence",
      second.fence > first.fence &&
        stale.ok === false &&
        stale.error?.kind === "stale-fence" &&
        fresh.ok === true &&
        after.stale_accepted.length === 0 &&
        before.fenced_updates + 1 === after.fenced_updates,
      {
        first_fence: first.fence,
        second_fence: second.fence,
        stale_error_kind: stale.error?.kind,
        fresh_ok: fresh.ok,
        status_after:
          shown.result?.data?.status ?? shown.result?.entity?.data?.status,
      },
    );

    // D3: a handoff survives a new process and is returned by reentry for a different participant.
    const created = sdkCall(
      storeFile,
      "w1",
      "handoff-create",
      "--summary",
      "drill handoff",
      "--ref",
      `task:${taskId}`,
    );
    const entered = sdkCall(
      storeFile,
      "w1r",
      "reentry",
      "--handoff-id",
      created.handoff_id ?? "",
    );
    record(
      "D3_handoff_reentry",
      created.ok === true &&
        entered.ok === true &&
        entered.handoff?.summary === "drill handoff",
      {
        handoff_created: created.ok === true,
        reentry_summary_matches: entered.handoff?.summary === "drill handoff",
        replacement_participant_distinct: true,
      },
    );

    const report = {
      schema: "tila.dogfood.drills/1",
      provenance: "harness_fixture",
      note: "Wiring checks of the run host and tool surface. Not agent outcomes and not product benchmarks.",
      runtime: {
        node: process.version,
        bun: execFileSync("bun", ["--version"], { encoding: "utf8" }).trim(),
      },
      results,
      pass: results.every((r) => r.pass),
    };
    writeJson(resolve(opts.out), report);
    console.log(JSON.stringify(report, null, 2));
    process.exit(report.pass ? 0 : 1);
  });
}

function cmdFreeze(opts) {
  const sourceRoot = resolve(opts["source-root"] ?? repoRoot);
  for (const required of [
    "run-dir",
    "model-id",
    "count-source",
    "usage-source",
    "host-label",
  ]) {
    if (!opts[required] || opts[required] === true)
      fail(`freeze needs --${required}`);
  }
  const run = resolve(opts["run-dir"]);
  const { findings, declaration } = manifestFindings(opts);
  if (findings.length)
    fail(`declaration does not verify:\n${JSON.stringify(findings, null, 2)}`);
  if (git(sourceRoot, "status", "--porcelain"))
    fail("source tree is dirty; commit before freezing");
  const drillsPath = resolve(opts.drills ?? join(run, "preflight/drills.json"));
  if (!existsSync(drillsPath))
    fail("preflight drills missing; run the drill command first");
  const drills = readJson(drillsPath);
  if (!drills.pass || drills.provenance !== "harness_fixture")
    fail("preflight drills did not pass");
  const smokePath = opts["hook-smoke"] && resolve(opts["hook-smoke"]);
  const smoke = smokePath ? readJson(smokePath) : null;
  const configHash = sha256Text(
    canonicalJson(
      buildHookSettings({
        hookScript: "$SOURCE/scripts/dogfood-study-tila.mjs",
        runDir: "$RUN",
        trial: "$TRIAL",
        role: "$ROLE",
      }),
    ),
  );
  const codexVersion = execFileSync("codex", ["--version"], {
    encoding: "utf8",
  }).trim();
  if (declaration.rubric.version >= 3) {
    if (
      !smoke ||
      smoke.provenance !== "harness_fixture" ||
      smoke.source_sha !== git(sourceRoot, "rev-parse", "HEAD") ||
      smoke.codex_version !== codexVersion ||
      smoke.config_template_sha256 !== configHash ||
      !/^[0-9a-f]{64}$/.test(smoke.binary_sha256 ?? "") ||
      !Array.isArray(smoke.checks) ||
      [
        "coverage",
        "identifiers",
        "parallel_39_40_41",
        "zero_effect_denial",
        "replacement_retirement",
        "deadline_closure",
        "malformed_failure",
        "terminal_cleanup",
      ].some(
        (name) =>
          !smoke.checks.some(
            (c) =>
              c.name === name &&
              c.pass === true &&
              typeof c.evidence_ref === "string" &&
              c.evidence_ref.length,
          ),
      )
    )
      fail(
        "v3 freeze requires linked installed-runtime hook smoke evidence; a boolean is insufficient",
      );
    if (
      !smoke.binary_path ||
      sha256Text(readFileSync(smoke.binary_path)) !== smoke.binary_sha256
    )
      fail("installed binary differs from the hook smoke binary hash");
    for (const check of smoke.checks) {
      const evidencePath = resolve(dirname(smokePath), check.evidence_ref);
      if (
        !evidencePath.startsWith(`${dirname(smokePath)}/`) ||
        !/^[0-9a-f]{64}$/.test(check.evidence_sha256 ?? "") ||
        sha256Text(readFileSync(evidencePath)) !== check.evidence_sha256
      )
        fail(
          "hook smoke requires retained run-owned evidence matching each check hash",
        );
    }
    if (opts["model-id"] !== "gpt-6.1-sol" || opts["count-source"] !== "hook")
      fail("v3 requires gpt-6.1-sol high and the run-owned hook count source");
  }
  if (!["hook", "transcript", "none"].includes(opts["count-source"]))
    fail("--count-source must be hook, transcript or none");
  if (!["native_usage_record", "none"].includes(opts["usage-source"]))
    fail("--usage-source must be native_usage_record or none");
  const frozen = {
    provenance:
      sourceRoot === repoRoot ? "local_agent_trial" : "harness_fixture",
    at_utc: new Date().toISOString(),
    source_sha: git(sourceRoot, "rev-parse", "HEAD"),
    source_tree_clean: true,
    runtime_versions: {
      node: process.version,
      bun: execFileSync("bun", ["--version"], { encoding: "utf8" }).trim(),
      codex: codexVersion,
    },
    model_id: opts["model-id"],
    effort: "high",
    count_source: opts["count-source"],
    hook_smoke_attested: smoke !== null,
    hook_smoke_sha256: smokePath
      ? sha256Text(readFileSync(smokePath, "utf8"))
      : null,
    hook_config_template_sha256: configHash,
    codex_binary_sha256: smoke?.binary_sha256 ?? null,
    usage_source: opts["usage-source"],
    host_label: opts["host-label"],
    host: { cpus: cpus().length, loadavg_1m: loadavg()[0] },
    drills_sha256: sha256Text(readFileSync(drillsPath, "utf8")),
    count_hook_sha256: sha256Text(
      readFileSync(join(here, "dogfood-study-tila.mjs"), "utf8"),
    ),
    count_hook_lib_sha256: sha256Text(
      readFileSync(join(here, "dogfood-study-lib.mjs"), "utf8"),
    ),
  };
  const manifest = { ...declaration, kind: "frozen", frozen };
  manifest.frozen_sha256 = sha256Text(canonicalJson(manifest));
  if (existsSync(join(run, "manifest.frozen.json")))
    fail(
      "frozen manifest already exists; retain it and use a new run directory",
    );
  writeJson(join(run, "manifest.frozen.json"), manifest);
  console.log(
    `frozen at ${frozen.source_sha}; hook smoke attested: ${frozen.hook_smoke_attested}`,
  );
}

function trialSlot(manifest, id) {
  if (id === "w-A" || id === "w-B") {
    return {
      trial: id,
      order: 0,
      pair: "warmup",
      condition: id.slice(2),
      variant: "w",
      scenario: manifest.warmup.scenario,
      replaced_role: "w2",
      role_items: { w1: "item1", w2: "item2" },
    };
  }
  const slot = manifest.trials.find((t) => t.trial === id);
  if (!slot) fail(`unknown trial ${id}`);
  return slot;
}

function scenarioFor(slot) {
  return slot.pair === "warmup"
    ? warmupScenario()
    : buildScenario(slot.pair, slot.variant);
}

function cmdPrepare(opts) {
  const run = resolve(opts["run-dir"] ?? fail("prepare needs --run-dir"));
  const manifest = opts.preflight
    ? { ...readJson(study(opts).declPath), frozen: { host_label: "preflight" } }
    : readJson(join(run, "manifest.frozen.json"));
  if (opts.preflight && !["w-A", "w-B"].includes(opts.trial))
    fail("--preflight permits only the unscored warm-up trials w-A and w-B");
  if (!opts.trial) fail("prepare needs --trial (t1..t4, w-A or w-B)");
  const slot = trialSlot(manifest, opts.trial);
  const scenario = scenarioFor(slot);
  if (slot.pair !== "warmup" && scenario.sha256 !== slot.scenario_sha256)
    fail("fixture changed since the declaration");
  const evaluatorRoot = resolve(opts["evaluator-dir"] ?? `${run}.evaluator`);
  const dir = join(run, "trials", slot.trial);
  if (existsSync(dir))
    fail(`${dir} already exists; trials are never re-prepared in place`);
  const repo = join(dir, "repo");
  const shared = join(dir, "shared");
  const version = readJson(join(repoRoot, "package.json")).version;

  // repository, baseline commit, two worktrees
  materializeFiles(scenario.repoFiles, repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "add", "-A");
  git(repo, ...GIT_ID, "commit", "-q", "-m", "baseline");
  const worktrees = {};
  for (const role of ["w1", "w2"]) {
    worktrees[role] = join(dir, `wt-${role}`);
    git(repo, "worktree", "add", "-q", "-b", role, worktrees[role], "main");
  }
  writeFileSync(join(repo, ".git/info/exclude"), ".tila/\nRESUME.txt\n");

  // shared coordination files exist in both conditions
  mkdirSync(join(shared, "locks"), { recursive: true });
  mkdirSync(join(shared, "HANDOFFS"), { recursive: true });
  writeFileSync(join(shared, "BOARD.md"), "# Board\n\n");
  writeFileSync(
    join(shared, "DECISIONS.md"),
    "# Decisions\n\n- D0: see NOTES.md\n\n",
  );
  writeFileSync(join(shared, "HANDOFFS/.keep"), "");

  const participants = { w1: "w1", w2: "w2", w1r: "w1r", w2r: "w2r" };
  const config = {
    trial: slot.trial,
    condition: slot.condition,
    scenario: scenario.id,
    run_dir: run,
    repo_root: repoRoot,
    rubric_path: manifest.rubric.path,
    machine_label: manifest.frozen.host_label,
    worktrees,
    shared,
    participants,
    replaced_role: slot.replaced_role,
    role_items: slot.role_items,
    task_ids: null,
    decision: {
      id: scenario.decision.id,
      key_phrases: scenario.decision.keyPhrases,
    },
    hidden_patterns: [
      "dogfood-study-fixtures",
      "dogfood-study.mjs",
      basename(evaluatorRoot),
      "accept.mjs",
      "cases.json",
      "factsheet",
      "issue-194-",
    ],
  };

  if (slot.condition === "B") {
    const store = {
      dbPath: join(dir, "state/project.db"),
      artifactsPath: join(dir, "state/artifacts"),
      org: "study",
      project: `study-${slot.trial}`,
    };
    mkdirSync(join(dir, "state"), { recursive: true });
    for (const wt of Object.values(worktrees))
      writeLocalConfig(wt, store, version);
    writeJson(join(dir, "store.json"), store);
    const make = (title) => {
      const made = cliCall(
        worktrees.w1,
        "orch",
        ["task", "new", title],
        config,
      );
      if (!made.ok) fail(`could not create task: ${JSON.stringify(made)}`);
      return made.result.id;
    };
    config.task_ids = {
      helper: make(`Shared helper ${scenario.helper.name}`),
      item1: make(`Implement ${scenario.items.item1.fn}`),
      item2: make(`Implement ${scenario.items.item2.fn}`),
    };
  }

  // packets (participant-visible, delivered by the orchestrator)
  const runner = join(here, "dogfood-study-tila.mjs");
  const packetsDir = join(dir, "packets");
  for (const role of ["w1", "w2"]) {
    const itemKey = slot.role_items[role];
    for (const [name, render, who] of [
      [`${role}.md`, renderWorkerPacket, role],
      [`entry-${role}.md`, renderEntryPacket, `${role}r`],
    ]) {
      const ctx = {
        scenario,
        itemKey,
        role: who,
        condition: slot.condition,
        worktree: worktrees[role],
        branch: role,
        shared,
        run,
        trial: slot.trial,
        participant: participants[who],
        runner,
        taskIds: config.task_ids && {
          helper: config.task_ids.helper,
          item: config.task_ids[itemKey],
        },
      };
      mkdirSync(packetsDir, { recursive: true });
      writeFileSync(join(packetsDir, name), render(ctx));
    }
  }
  writeFileSync(
    join(packetsDir, "decision.txt"),
    `${renderDecisionMessage(scenario)}\n`,
  );

  // Invocation-local Codex argv, outside every worktree; the lead reviews trust/permissions.
  for (const role of ["w1", "w2"]) {
    writeJson(
      join(dir, `settings-${role}.json`),
      buildHookSettings({
        hookScript: runner,
        runDir: run,
        trial: slot.trial,
        role,
      }),
    );
  }

  // hidden evaluator inputs live outside the run directory
  const evalDir = join(evaluatorRoot, slot.trial);
  mkdirSync(evalDir, { recursive: true });
  writeFileSync(join(evaluatorRoot, "accept.mjs"), ACCEPT_RUNNER_SOURCE);
  writeJson(join(evalDir, "cases.json"), scenario.cases);
  writeJson(
    join(evalDir, "factsheets.json"),
    Object.fromEntries(
      ["w1", "w2"].map((r) => [r, factSheet(scenario, r, slot.role_items[r])]),
    ),
  );
  config.evaluator_dir = evaluatorRoot;
  writeJson(join(dir, "trial.json"), config);

  const rubric = readJson(join(repoRoot, manifest.rubric.path));
  appendEvent(
    join(dir, "events.jsonl"),
    {
      kind: "trial.prepared",
      actor: { role: "harness" },
      provenance:
        slot.pair === "warmup" ? "harness_fixture" : "local_agent_trial",
      payload: {
        condition: slot.condition,
        scenario: scenario.id,
        scenario_sha256: scenario.sha256,
        packet_sha256: Object.fromEntries(
          readdirSync(packetsDir).map((f) => [
            f,
            sha256Text(readFileSync(join(packetsDir, f), "utf8")),
          ]),
        ),
      },
    },
    rubric,
  );
  console.log(
    JSON.stringify(
      {
        trial: slot.trial,
        condition: slot.condition,
        dir,
        packets: packetsDir,
        settings: {
          w1: join(dir, "settings-w1.json"),
          w2: join(dir, "settings-w2.json"),
        },
        worktrees,
        task_ids: config.task_ids,
      },
      null,
      2,
    ),
  );
}

function basename(p) {
  return p.split("/").filter(Boolean).pop();
}

function cmdRecord(opts) {
  const run = resolve(opts["run-dir"] ?? fail("record needs --run-dir"));
  const dir = join(run, "trials", opts.trial ?? fail("record needs --trial"));
  const config = readJson(join(dir, "trial.json"));
  const rubric = readJson(join(repoRoot, config.rubric_path));
  const payload = opts.payload ? JSON.parse(opts.payload) : {};
  if (opts.kind === "trial.started" && payload.loadavg_1m === undefined)
    payload.loadavg_1m = loadavg()[0];
  const event = appendEvent(
    join(dir, "events.jsonl"),
    {
      kind: opts.kind,
      actor: { role: opts.actor ?? "harness" },
      provenance: opts.provenance ?? "local_agent_trial",
      payload,
    },
    rubric,
  );
  console.log(JSON.stringify({ seq: event.seq, ts_utc: event.ts_utc }));
}

function cmdEvaluate(opts) {
  const run = resolve(opts["run-dir"] ?? fail("evaluate needs --run-dir"));
  const dir = join(run, "trials", opts.trial ?? fail("evaluate needs --trial"));
  const config = readJson(join(dir, "trial.json"));
  const manifest = readJson(join(run, "manifest.frozen.json"));
  const slot = trialSlot(manifest, opts.trial);
  const scenario = scenarioFor(slot);
  const evalDir = join(config.evaluator_dir, opts.trial);
  const cases = readJson(join(evalDir, "cases.json"));
  const sheets = readJson(join(evalDir, "factsheets.json"));
  const repo = join(dir, "repo");
  const scratch = join(dir, "eval-scratch");
  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(scratch, { recursive: true });
  const rubric = readJson(join(repoRoot, config.rubric_path));

  // 1. Attribute commits using the run-owned branch reflogs. Reachability alone cannot
  // distinguish an imported commit from its original author's work after a merge.
  const base = git(repo, "rev-parse", "main");
  const commitOrigins = {};
  const commits = git(repo, "rev-list", "--reverse", "w1", "w2", "^main")
    .split("\n")
    .filter(Boolean);
  for (const role of ["w1", "w2"]) {
    const reflog = git(repo, "reflog", "show", "--format=%H%x09%gs", role);
    for (const line of reflog.split("\n")) {
      const [commit, subject] = line.split("\t");
      if (!commits.includes(commit)) continue;
      if (
        /^commit(?: \([^)]*\))?:/.test(subject) ||
        /^merge .*: Merge made by/.test(subject)
      ) {
        if (commitOrigins[commit] && commitOrigins[commit] !== role)
          fail(`ambiguous origin for ${commit}; retain the run for audit`);
        commitOrigins[commit] = role;
      }
    }
  }
  for (const commit of commits) {
    if (!commitOrigins[commit])
      fail(`missing branch provenance for ${commit}; retain the run for audit`);
  }
  const branches = {};
  const forbidden = [];
  const tampering = [];
  // Audit every unique commit for immutable paths, including changes imported by both
  // branches and merge commits. This is independent of role-specific permissions.
  for (const commit of commits) {
    for (const change of commitChanges(repo, commit, "first-parent")) {
      if (scenario.frozenPaths.includes(change.path))
        tampering.push({ role: commitOrigins[commit], commit, ...change });
    }
  }
  for (const role of ["w1", "w2"]) {
    const head = git(repo, "rev-parse", role);
    const reachable = git(repo, "rev-list", role, "^main")
      .split("\n")
      .filter(Boolean);
    const authoredCommits = commits.filter((c) => commitOrigins[c] === role);
    const importedCommits = reachable.filter((c) => commitOrigins[c] !== role);
    // Combined merge diffs contain resolution edits, rather than unchanged imports.
    const authored = authoredCommits.flatMap((commit) =>
      commitChanges(repo, commit, "combined").map((c) => ({ commit, ...c })),
    );
    const allowed = allowedPaths(scenario, role, slot.role_items[role]);
    const permitted = (c) =>
      allowed.exact.includes(c.path) ||
      (c.status === "A" &&
        allowed.prefixNewOnly.some((p) => c.path.startsWith(p)));
    for (const c of authored) {
      if (!permitted(c))
        forbidden.push({
          role,
          path: c.path,
          status: c.status,
          where: "committed",
        });
    }
    // uncommitted edits are audited too (they are not integrated)
    const dirty = git(config.worktrees[role], "status", "--porcelain")
      .split("\n")
      .filter(Boolean)
      .map((l) => ({ status: l.slice(0, 2).trim(), path: l.slice(3) }));
    for (const c of dirty) {
      const isNew = c.status === "??" || c.status === "A";
      if (!permitted({ status: isNew ? "A" : "M", path: c.path }))
        forbidden.push({
          role,
          path: c.path,
          status: c.status,
          where: "uncommitted",
        });
      if (scenario.frozenPaths.includes(c.path))
        tampering.push({ role, path: c.path });
    }
    branches[role] = {
      head,
      authored_commits: authoredCommits,
      imported_commits: importedCommits,
      authored,
      uncommitted: dirty.map((d) => d.path),
    };
  }
  const uncommitted = Object.fromEntries(
    Object.entries(branches)
      .filter(([, b]) => b.uncommitted.length)
      .map(([r, b]) => [r, b.uncommitted]),
  );

  // 2. harness integration in a scratch clone; conflicts are never resolved here
  const clone = join(scratch, "integrated");
  git(scratch, "clone", "-q", repo, clone);
  git(clone, "checkout", "-q", "main");
  const integration = { merged: [], conflict: false, conflicted_files: [] };
  for (const role of ["w1", "w2"]) {
    const merged = spawnSync(
      "git",
      [...GIT_ID, "merge", "--no-edit", `origin/${role}`],
      { cwd: clone, encoding: "utf8" },
    );
    if (merged.status !== 0) {
      integration.conflict = true;
      integration.conflicted_files = git(
        clone,
        "diff",
        "--name-only",
        "--diff-filter=U",
      )
        .split("\n")
        .filter(Boolean);
      spawnSync("git", ["merge", "--abort"], { cwd: clone });
      break;
    }
    integration.merged.push(role);
  }

  // 3. frozen acceptance, visible tests, helper definitions, obsolete work
  let results = [];
  let visible = null;
  let helperDefinitions = null;
  if (!integration.conflict) {
    results = runAccept(evalDir, clone, cases);
    visible =
      spawnSync("node", ["--test", "test/"], { cwd: clone, encoding: "utf8" })
        .status === 0;
    const re = new RegExp(
      `(function\\s+${scenario.helper.name}\\b|const\\s+${scenario.helper.name}\\s*=)`,
      "g",
    );
    const locations = [];
    for (const f of git(clone, "ls-files", "src").split("\n").filter(Boolean)) {
      const n = (readFileSync(join(clone, f), "utf8").match(re) ?? []).length;
      if (n) locations.push({ file: f, count: n });
    }
    helperDefinitions = {
      count: locations.reduce((a, l) => a + l.count, 0),
      locations,
    };
  }
  const obsolete = [];
  for (const role of ["w1", "w2"]) {
    const item = slot.role_items[role];
    const failing = results.filter(
      (r) =>
        r.tags.includes(item) &&
        r.tags.includes(scenario.decision.id) &&
        !r.pass,
    );
    if (failing.length) obsolete.push(role);
  }

  // 4. injected overlap: who owned the helper, and did the other role build a second one
  const events = parseEvents(
    existsSync(join(dir, "events.jsonl"))
      ? readFileSync(join(dir, "events.jsonl"), "utf8")
      : "",
  ).events;
  let owner = null;
  let evidenceSeq = null;
  if (config.condition === "B") {
    const claim = events.find(
      (e) =>
        e.kind === "tila_call" &&
        e.payload.verb === "sdk claim" &&
        e.payload.resource === `task:${config.task_ids.helper}` &&
        e.payload.outcome === "ok",
    );
    owner = claim ? baseOf(claim.payload.role) : null;
    const lost = events.find(
      (e) =>
        e.kind === "tila_call" &&
        e.payload.verb === "sdk claim" &&
        e.payload.resource === `task:${config.task_ids.helper}` &&
        e.payload.outcome === "conflict",
    );
    evidenceSeq = lost?.seq ?? null;
  } else {
    const board = readFileSync(join(config.shared, "BOARD.md"), "utf8");
    const m = /shared-helper:\s*owner=(w[12])/.exec(board);
    owner = m ? m[1] : null;
    evidenceSeq = m ? `BOARD.md:${m.index}` : null;
    const lock = join(config.shared, "locks/shared-helper/owner");
    if (!owner && existsSync(lock)) {
      const named = /^(w[12])/.exec(readFileSync(lock, "utf8"));
      owner = named ? named[1] : null;
      evidenceSeq = named ? "locks/shared-helper/owner" : null;
    }
  }
  const other = owner === "w1" ? "w2" : owner === "w2" ? "w1" : null;
  const otherDefines = other
    ? authoredDefinesHelper(repo, branches[other].authored_commits, scenario)
    : null;
  const overlap = {
    overlap_id: "injected-helper",
    kind: "injected",
    resource: scenario.helper.file,
    role: other ?? "unknown",
    response:
      other === null
        ? "ignored"
        : otherDefines
          ? "duplicate_started"
          : evidenceSeq
            ? "redirected"
            : "ignored",
    evidence_ref:
      otherDefines || !evidenceSeq ? undefined : String(evidenceSeq),
    edits_before_redirect: otherDefines ? 1 : 0,
    owner,
  };

  // 5. fence audit from journal order (condition B)
  let fenceAudit = null;
  if (config.condition === "B") {
    const dump = sdkCall(join(dir, "store.json"), "evaluator", "journal-dump");
    if (dump.ok) {
      const rows = dump.events.filter((r) => r.participant_id !== "orch");
      fenceAudit = auditJournal(rows);
    }
  }

  // 6. handoff of the replaced role, scored mechanically
  const replaced = slot.replaced_role;
  let handoffText = null;
  if (config.condition === "A") {
    const f = join(config.shared, "HANDOFFS", `${replaced}.md`);
    handoffText = existsSync(f) ? readFileSync(f, "utf8") : null;
  } else {
    const list = sdkCall(
      join(dir, "store.json"),
      config.participants[replaced],
      "handoff-list",
    );
    const mine = (list.handoffs ?? []).filter(
      (h) => h.creator?.participant_id === config.participants[replaced],
    );
    handoffText = mine.length
      ? mine
          .map((h) =>
            [
              h.summary,
              ...(h.findings ?? []),
              JSON.stringify(h.current_state ?? {}),
            ].join("\n"),
          )
          .join("\n")
      : null;
  }
  const handoff =
    handoffText === null
      ? null
      : {
          role: replaced,
          text_sha256: sha256Text(handoffText),
          ...handoffCandidates(handoffText, sheets[replaced]),
        };
  const resumeFile = join(config.worktrees[replaced], "RESUME.txt");
  const resumeText = existsSync(resumeFile)
    ? readFileSync(resumeFile, "utf8")
    : null;
  const resume =
    resumeText === null
      ? null
      : {
          role: replaced,
          decision_candidate: resumeDecisionCandidate(resumeText, scenario),
          text_sha256: sha256Text(resumeText),
        };

  // captured facts a separate reviewer verifies the handoff and RESUME note against
  const roleHead = branches[replaced].head;
  const visibleAtHead = (() => {
    const wt = join(scratch, "reviewed-head");
    git(repo, "worktree", "add", "-q", "--detach", wt, roleHead);
    const ok =
      spawnSync("node", ["--test", "test/"], { cwd: wt, encoding: "utf8" })
        .status === 0;
    git(repo, "worktree", "remove", "--force", wt);
    return ok;
  })();
  const neutral = `r-${sha256Text(`${manifest.study_id}|${slot.trial}`).slice(0, 8)}`;
  const reviewPacket = {
    schema: "tila.dogfood.review-packet/1",
    neutral_id: neutral,
    contract: {
      item: scenario.items[slot.role_items[replaced]].text,
      shared_helper: scenario.helper.name,
      decision: scenario.decision.text,
    },
    captured: {
      role_branch_commits: git(
        repo,
        "log",
        "--format=%h %s",
        `main..${replaced}`,
      )
        .split("\n")
        .filter(Boolean),
      files_changed_vs_main: git(
        repo,
        "diff",
        "--name-only",
        `main..${replaced}`,
      )
        .split("\n")
        .filter(Boolean),
      visible_tests_pass_at_branch_head: visibleAtHead,
      acceptance_on_integrated_tree: integration.conflict
        ? null
        : { passed: results.filter((r) => r.pass).length, of: results.length },
    },
    handoff_text: handoffText,
    resume_text: resumeText,
    resume_sha256: resumeText === null ? null : sha256Text(resumeText),
    candidates: {
      handoff: handoff?.facts ?? null,
      resume: resume?.decision_candidate ?? null,
    },
    verdict_template: {
      schema: "tila.dogfood.review/1",
      reviewer: "<synthetic label>",
      blinded: "<true if condition labels were not visible>",
      handoff: {
        facts: Object.fromEntries(
          sheets[replaced].facts.map((f) => [
            f.id,
            "correct | incorrect | absent",
          ]),
        ),
      },
      resume: {
        text_sha256: resumeText === null ? null : sha256Text(resumeText),
        decision_correct:
          "<true only if the full D1 rule is stated and not contradicted>",
      },
    },
  };
  mkdirSync(join(run, "review-packets"), { recursive: true });
  writeJson(join(run, "review-packets", `${neutral}.json`), reviewPacket);
  writeJson(join(evaluatorRoot(config), "review-mapping.private.json"), {
    ...(existsSync(join(evaluatorRoot(config), "review-mapping.private.json"))
      ? readJson(join(evaluatorRoot(config), "review-mapping.private.json"))
      : {}),
    [neutral]: slot.trial,
  });

  // 7. acknowledged state that must still be present (silent-overwrite check)
  const silent = [];
  if (config.condition === "A") {
    const decisions = readFileSync(join(config.shared, "DECISIONS.md"), "utf8");
    for (const e of events.filter(
      (x) => x.kind === "decision.acked" && x.payload.system === "board",
    )) {
      if (!decisions.includes(`ACK ${e.payload.decision_id} ${e.payload.role}`))
        silent.push({
          kind: "acked_line_missing",
          seq: e.seq,
          confirmed: true,
        });
    }
    const boardText = readFileSync(join(config.shared, "BOARD.md"), "utf8");
    for (const e of events.filter(
      (x) => x.kind === "result.declared" && x.payload.kind === "board",
    )) {
      const word = e.payload.reaffirmed ? "REAFFIRM" : "RESULT";
      if (
        !boardText.includes(
          `${word} ${e.payload.role} ${e.payload.explicit_ref}`,
        )
      )
        silent.push({
          kind: "result_line_missing",
          seq: e.seq,
          confirmed: true,
        });
    }
  } else {
    for (const e of events.filter(
      (x) =>
        x.kind === "tila_call" &&
        x.payload.verb === "task update" &&
        x.payload.outcome === "ok" &&
        x.payload.fields,
    )) {
      const shown = cliCall(
        config.worktrees.w1,
        "evaluator",
        ["task", "show", e.payload.resource],
        config,
      );
      const data = shown.result?.data ?? shown.result?.entity?.data ?? {};
      for (const [k, v] of Object.entries(e.payload.fields)) {
        if (String(data[k]) !== v && !later(events, e, k))
          silent.push({
            kind: "acked_field_replaced",
            seq: e.seq,
            field: k,
            confirmed: true,
          });
      }
    }
  }

  const evaluation = {
    schema: "tila.dogfood.evaluation/1",
    trial: slot.trial,
    scenario_sha256: scenario.sha256,
    base,
    branches,
    commit_origins: commitOrigins,
    uncommitted,
    integration,
    cases: results,
    visible_tests_pass: visible,
    forbidden_paths: forbidden,
    tampering,
    helper_definitions: helperDefinitions,
    obsolete_work_roles: obsolete,
    overlap,
    fence_audit: fenceAudit,
    handoff,
    resume,
    silent_overwrite_candidates: silent,
  };
  writeJson(join(dir, "evaluation.json"), evaluation);
  appendEvent(
    join(dir, "events.jsonl"),
    {
      kind: "overlap.observed",
      actor: { role: "evaluator" },
      payload: { ...overlap, role: overlap.role },
    },
    rubric,
  );
  appendEvent(
    join(dir, "events.jsonl"),
    {
      kind: "evaluation.completed",
      actor: { role: "evaluator" },
      payload: {
        evaluation_sha256: sha256Text(
          readFileSync(join(dir, "evaluation.json"), "utf8"),
        ),
      },
    },
    rubric,
  );
  rmSync(scratch, { recursive: true, force: true });
  console.log(
    JSON.stringify(
      {
        trial: slot.trial,
        integration,
        passed: results.filter((r) => r.pass).length,
        cases: results.length,
      },
      null,
      2,
    ),
  );
}

function evaluatorRoot(config) {
  return config.evaluator_dir;
}

function baseOf(role) {
  return role.replace(/r$/, "");
}

/** True when a later successful update in the log set the same field again. */
function later(events, e, field) {
  return events.some(
    (x) =>
      x.seq > e.seq &&
      x.kind === "tila_call" &&
      x.payload.verb === "task update" &&
      x.payload.outcome === "ok" &&
      x.payload.resource === e.payload.resource &&
      x.payload.fields?.[field] !== undefined,
  );
}

function commitChanges(repo, commit, mergeMode) {
  const fields = git(
    repo,
    "show",
    "--format=",
    `--diff-merges=${mergeMode}`,
    "--no-renames",
    "--name-status",
    "-z",
    commit,
  ).split("\0");
  const changes = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const status = fields[i];
    changes.push({
      status: /^A+$/.test(status) ? "A" : status,
      path: fields[i + 1],
    });
  }
  return changes;
}

function authoredDefinesHelper(repo, commits, scenario) {
  const diff = commits
    .map((commit) =>
      git(
        repo,
        "show",
        "--format=",
        "--diff-merges=combined",
        "--no-renames",
        commit,
        "--",
        scenario.helper.file,
        ...Object.values(scenario.items).map((i) => i.file),
      ),
    )
    .join("\n");
  return new RegExp(
    `^\\+.*(function\\s+${scenario.helper.name}\\b|const\\s+${scenario.helper.name}\\s*=)`,
    "m",
  ).test(diff);
}

function loadBundle(dir, manifest) {
  const trials = {};
  const tdir = join(dir, "trials");
  for (const id of existsSync(tdir) ? readdirSync(tdir) : []) {
    if (id.startsWith("w-")) continue;
    const t = join(tdir, id);
    const evFile = join(t, "events.jsonl");
    const parsed = existsSync(evFile)
      ? parseEvents(readFileSync(evFile, "utf8"))
      : { events: [], problems: ["events.jsonl missing"] };
    trials[id] = {
      events: parsed.events,
      parseProblems: parsed.problems,
      evaluation: existsSync(join(t, "evaluation.json"))
        ? readJson(join(t, "evaluation.json"))
        : null,
      ledger: existsSync(join(t, "ledger.json"))
        ? readJson(join(t, "ledger.json"))
        : null,
      review: existsSync(join(t, "review.json"))
        ? readJson(join(t, "review.json"))
        : null,
    };
  }
  return {
    frozen: manifest,
    trials,
    drills: existsSync(join(dir, "preflight/drills.json"))
      ? readJson(join(dir, "preflight/drills.json"))
      : null,
  };
}

function cmdDerive(opts) {
  const run = resolve(opts["run-dir"] ?? fail("derive needs --run-dir"));
  const manifest = readJson(join(run, "manifest.frozen.json"));
  const rubric = readJson(join(repoRoot, manifest.rubric.path));
  const slot = trialSlot(manifest, opts.trial ?? fail("derive needs --trial"));
  const dir = join(run, "trials", slot.trial);
  const events = parseEvents(
    readFileSync(join(dir, "events.jsonl"), "utf8"),
  ).events;
  const evaluation = existsSync(join(dir, "evaluation.json"))
    ? readJson(join(dir, "evaluation.json"))
    : null;
  const review = existsSync(join(dir, "review.json"))
    ? readJson(join(dir, "review.json"))
    : null;
  const ledger = deriveLedger({
    trial: slot,
    events,
    evaluation,
    review,
    frozen: manifest.frozen,
    rubric,
  });
  writeJson(join(dir, "ledger.json"), ledger);
  console.log(
    JSON.stringify(
      {
        trial: slot.trial,
        outcome: ledger.outcome,
        flags: ledger.flags,
        gates: ledger.gates,
      },
      null,
      2,
    ),
  );
}

function cmdValidate(opts) {
  const dir = resolve(opts.bundle ?? fail("validate needs --bundle"));
  const manifest = readJson(join(dir, "manifest.frozen.json"));
  const rubricText = readFileSync(join(repoRoot, manifest.rubric.path), "utf8");
  const declaration = readJson(resolve(repoRoot, opts.declaration ?? DECL_REL));
  const result = validateBundle({
    bundle: loadBundle(dir, manifest),
    rubric: JSON.parse(rubricText),
    rubricSha256: sha256Text(rubricText),
    declaration,
  });
  if (opts.json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(
      `ok=${result.ok} reading=${result.reading} claim_level=${result.claim_level}`,
    );
    for (const f of result.findings)
      console.log(
        `${f.severity.toUpperCase()} ${f.code}${f.trial ? ` [${f.trial}]` : ""}: ${f.message}`,
      );
  }
  process.exit(result.ok ? 0 : 1);
}

const commands = {
  allocate: cmdAllocate,
  declare: cmdDeclare,
  "manifest-check": cmdManifestCheck,
  drill: cmdDrill,
  freeze: cmdFreeze,
  prepare: cmdPrepare,
  record: cmdRecord,
  evaluate: cmdEvaluate,
  derive: cmdDerive,
  validate: cmdValidate,
};

const [name, ...rest] = process.argv.slice(2);
if (!commands[name])
  fail(
    `usage: dogfood-study.mjs <${Object.keys(commands).join("|")}> [options]`,
    64,
  );
commands[name](parseArgs(rest).opts);
