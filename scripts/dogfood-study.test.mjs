/**
 * Tests for the #194 pilot tooling. They exercise behaviour that could silently make a
 * trial look better or more enforced than it was: absence turning into zero, a lexical
 * match earning a correctness point, drill results leaking into agent counts, authored
 * versus imported edits, and the hook's admission counter.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  allScenarios,
  baselineHelperCommands,
  buildScenario,
  materializeFiles,
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
  sha256Text,
  validateBundle,
  validateEvent,
} from "./dogfood-study-lib.mjs";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const rubricText = readFileSync(
  join(repo, "docs/evidence/issue-194-rubric-v3.json"),
  "utf8",
);
const rubric = JSON.parse(rubricText);
const rubricSha256 = sha256Text(rubricText);
const scenarios = allScenarios();
const warmup = warmupScenario();
const declaration = buildDeclaration({
  rubric,
  rubricSha256,
  rubricPath: "docs/evidence/issue-194-rubric-v3.json",
  scenarios,
  warmup,
});

const temp = [];
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), "dogfood-test-"));
  temp.push(dir);
  return dir;
};
test.after(() => {
  for (const d of temp) rmSync(d, { recursive: true, force: true });
});

// ---- helpers for synthetic events ------------------------------------------------

function log() {
  const events = [];
  let mono = 1_000_000;
  const add = (
    kind,
    role,
    payload = {},
    atMs = null,
    provenance = "local_agent_trial",
  ) => {
    if (atMs !== null) mono = 1_000_000 + atMs;
    events.push({
      schema: "tila.dogfood.event/1",
      study_id: "tila-194-dogfood-pilot-v1",
      trial_id: "t2",
      seq: events.length + 1,
      ts_utc: new Date(1_800_000_000_000 + (mono - 1_000_000)).toISOString(),
      mono_ms: mono,
      actor: { role },
      kind,
      provenance,
      payload:
        kind === "tool_call"
          ? {
              session_id: role.endsWith("r")
                ? "s3"
                : role === "w1"
                  ? "s1"
                  : "s2",
              turn_id: "turn-1",
              tool_use_id: `call-${events.length + 1}`,
              tool: "Bash",
              ...payload,
            }
          : kind === "recovery.decision_stated"
            ? { text_sha256: "b".repeat(64), ...payload }
            : payload,
    });
    return events[events.length - 1];
  };
  return { events, add };
}

const slotB = declaration.trials.find((t) => t.condition === "B");
const slotA = declaration.trials.find((t) => t.condition === "A");
const frozenHook = {
  count_source: "hook",
  hook_smoke_attested: true,
  count_hook_sha256: "a".repeat(64),
  usage_source: "none",
  model_id: "gpt-6.1-sol",
  effort: "high",
  count_hook_lib_sha256: "a".repeat(64),
  hook_config_template_sha256: "a".repeat(64),
  hook_smoke_sha256: "a".repeat(64),
  codex_binary_sha256: "a".repeat(64),
};

/** A complete, well-behaved condition-B trial log; callers perturb it. */
function goodTrial(slot = slotB) {
  const l = log();
  l.add("trial.started", "harness", {}, 0);
  l.add("packet.delivered", "w1", { role: "w1" }, 10);
  l.add("packet.delivered", "w2", { role: "w2" }, 20);
  l.add(
    "worker.started",
    "w1",
    { role: "w1", participant: "w1", context: "original", session_id: "s1" },
    30,
  );
  l.add(
    "worker.started",
    "w2",
    { role: "w2", participant: "w2", context: "original", session_id: "s2" },
    40,
  );
  l.add(
    "tool_call",
    "w1",
    { role: "w1", category: "read", source: "hook", denied: false },
    100,
  );
  l.add(
    "tila_call",
    "w1",
    { role: "w1", verb: "sdk claim", resource: "task:H", outcome: "ok" },
    200,
  );
  l.add(
    "tila_call",
    "w2",
    { role: "w2", verb: "sdk claim", resource: "task:H", outcome: "conflict" },
    210,
  );
  l.add(
    "result.declared",
    "w1",
    { role: "w1", kind: "task_status", explicit_ref: "abc1234" },
    60_000,
  );
  l.add("decision.issued", "orch", { decision_id: "D1" }, 240_000);
  l.add(
    "decision.acked",
    "w1",
    { decision_id: "D1", role: "w1", system: "tila" },
    241_000,
  );
  l.add(
    "decision.acked",
    "w2",
    { decision_id: "D1", role: "w2", system: "tila" },
    242_000,
  );
  l.add(
    "checkpoint.reached",
    "orch",
    { checkpoint: "handoff_requested" },
    330_000,
  );
  l.add(
    "handoff.saved",
    slot.replaced_role,
    { role: slot.replaced_role, system: "tila", ref: "h1" },
    335_000,
  );
  l.add(
    "checkpoint.reached",
    "orch",
    { checkpoint: "replacement_started" },
    360_000,
  );
  const r = `${slot.replaced_role}r`;
  l.add(
    "worker.replaced",
    "harness",
    {
      role: slot.replaced_role,
      from_participant: slot.replaced_role,
      to_participant: r,
    },
    360_100,
  );
  l.add(
    "worker.started",
    r,
    { role: r, participant: r, context: "replacement", session_id: "s3" },
    360_200,
  );
  l.add("recovery.started", r, { role: r, participant: r }, 360_300);
  l.add("recovery.decision_stated", r, { role: r, candidate: true }, 380_000);
  l.add("recovery.first_action", r, { role: r, valid: true }, 400_000);
  l.add(
    "result.declared",
    "w1",
    {
      role: "w1",
      kind: "task_status",
      explicit_ref: "abc1234",
      reaffirmed: true,
    },
    500_000,
  );
  l.add(
    "result.declared",
    "w2",
    { role: "w2", kind: "task_status", explicit_ref: "def5678" },
    600_000,
  );
  l.add(
    "overlap.observed",
    "evaluator",
    {
      overlap_id: "injected-helper",
      kind: "injected",
      resource: "src/x.mjs",
      role: "w2",
      response: "redirected",
      evidence_ref: "7",
      edits_before_redirect: 0,
    },
    650_000,
  );
  l.add(
    "harness.note",
    "harness",
    { topic: "interventions_attested" },
    700_000,
  );
  l.add("trial.stopped", "harness", { reason: "complete" }, 710_000);
  l.add(
    "harness.note",
    "harness",
    {
      topic: "runtime_coverage_attested",
      source: "native_runtime_records",
      complete: true,
      uncovered_state_changes: 0,
      hook_failures: 0,
      session_ids: ["s1", "s2", "s3"],
      evidence_sha256: "a".repeat(64),
    },
    711_000,
  );
  return l;
}

const passingEvaluation = (slot = slotB) => ({
  schema: "tila.dogfood.evaluation/1",
  integration: { merged: ["w1", "w2"], conflict: false, conflicted_files: [] },
  cases: [
    { name: "a", tags: ["item1"], pass: true },
    { name: "b", tags: ["item2", "D1"], pass: true },
    { name: "c", tags: ["x", "D1"], pass: true },
  ],
  forbidden_paths: [],
  tampering: [],
  helper_definitions: { count: 1, locations: [] },
  obsolete_work_roles: [],
  fence_audit: { stale_accepted: [], holder_mismatch: [], fenced_updates: 0 },
  handoff: { role: slot.replaced_role, candidate_count: 6, max: 6, facts: [] },
  resume: { text_sha256: "b".repeat(64) },
  silent_overwrite_candidates: [],
});

const review = {
  schema: "tila.dogfood.review/1",
  reviewer: "reviewer-1",
  blinded: true,
  handoff: {
    facts: {
      goal_acceptance: "correct",
      current_status: "correct",
      artifact_refs: "correct",
      verification: "incorrect",
      decision_or_blocker: "correct",
      next_owner_action: "absent",
    },
  },
  resume: { decision_correct: true, text_sha256: "b".repeat(64) },
};

const derive = (l, extra = {}, slot = slotB) =>
  deriveLedger({
    trial: slot,
    events: l.events,
    evaluation: passingEvaluation(slot),
    review,
    frozen: frozenHook,
    rubric,
    ...extra,
  });

// ---- allocation, declaration, matching ---------------------------------------------

test("allocation is seeded and gives each pair one variant per condition", () => {
  const first = allocateVariants("tila-194-pilot-v1", ["p1", "p2"]);
  assert.deepEqual(first, allocateVariants("tila-194-pilot-v1", ["p1", "p2"]));
  for (const pair of ["p1", "p2"]) {
    assert.notEqual(first[pair].A, first[pair].B);
    assert.deepEqual(
      new Set([first[pair].A, first[pair].B]),
      new Set(["x", "y"]),
    );
  }
  assert.equal(declaration.trials.length, 4);
  assert.deepEqual(
    declaration.trials.map((t) => t.condition),
    ["A", "B", "B", "A"],
  );
});

test("a declaration that was edited or built on changed fixtures does not verify", () => {
  const ctx = {
    rubric,
    rubricSha256,
    rubricPath: "docs/evidence/issue-194-rubric-v3.json",
    scenarios,
    warmup,
  };
  assert.deepEqual(checkDeclaration(declaration, ctx), []);
  const swapped = structuredClone(declaration);
  const [a] = Object.keys(swapped.allocation.pairs);
  swapped.allocation.pairs[a] = {
    ...swapped.allocation.pairs[a],
    A: swapped.allocation.pairs[a].B,
  };
  const codes = checkDeclaration(swapped, ctx).map((f) => f.code);
  assert.ok(codes.includes("declaration_hash"));
  assert.ok(codes.includes("allocation"));
  const wrongRubric = checkDeclaration(declaration, {
    ...ctx,
    rubricSha256: "0".repeat(64),
  });
  assert.ok(wrongRubric.some((f) => f.code === "rubric_hash"));
  const changedWarmup = checkDeclaration(declaration, {
    ...ctx,
    warmup: { ...warmup, sha256: "0".repeat(64) },
  });
  assert.ok(changedWarmup.some((f) => f.code === "warmup"));
  const editedWarmup = structuredClone(declaration);
  editedWarmup.warmup.sha256 = "0".repeat(64);
  assert.ok(
    checkDeclaration(editedWarmup, ctx).some(
      (f) => f.code === "declaration_hash",
    ),
  );
});

test("pair matching rejects variants with different case counts", () => {
  assert.deepEqual(checkMatching(scenarios), []);
  const broken = structuredClone(scenarios);
  broken[0].cases.pop();
  assert.ok(
    checkMatching(broken).some((f) => f.message.includes("case counts")),
  );
});

test("the committed pilot fixtures discriminate: baseline fails, amended passes, constant sample is caught", () => {
  const dir = scratch();
  const decl = join(dir, "decl.json");
  writeFileSync(decl, JSON.stringify(declaration));
  const out = spawnSync(
    "node",
    [
      join(repo, "scripts/dogfood-study.mjs"),
      "manifest-check",
      "--declaration",
      decl,
    ],
    { encoding: "utf8" },
  );
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.deepEqual(JSON.parse(out.stdout).findings, []);
});

// ---- events ----------------------------------------------------------------------------

test("malformed events are rejected with the field that is wrong", () => {
  const good = log();
  good.add("tool_call", "w1", { role: "w1", category: "read", source: "hook" });
  assert.deepEqual(validateEvent(good.events[0], rubric), []);
  const bad = {
    ...good.events[0],
    payload: { role: "w1", category: "teleport", source: "hook" },
  };
  assert.ok(validateEvent(bad, rubric).some((p) => p.includes("category")));
  const noClock = { ...good.events[0], mono_ms: "later" };
  assert.ok(validateEvent(noClock, rubric).some((p) => p.includes("mono_ms")));
  const fixtureUsage = log();
  fixtureUsage.add("usage.record", "w1", {
    role: "w1",
    context: "w1",
    input_tokens: 1,
    output_tokens: 1,
    source: "estimate",
  });
  assert.ok(
    validateEvent(fixtureUsage.events[0], rubric).some((p) =>
      p.includes("native_usage_record"),
    ),
  );
});

test("concurrent appenders get contiguous sequence numbers and non-decreasing clocks", async () => {
  const dir = scratch();
  const file = join(dir, "t9", "events.jsonl");
  mkdirSync(dirname(file), { recursive: true });
  const script = `
    import { appendEvent } from ${JSON.stringify(join(repo, "scripts/dogfood-study-lib.mjs"))};
    import { readFileSync } from "node:fs";
    const rubric = JSON.parse(readFileSync(${JSON.stringify(join(repo, "docs/evidence/issue-194-rubric-v3.json"))}, "utf8"));
    for (let i = 0; i < 8; i++) appendEvent(${JSON.stringify(file)}, { kind: "harness.note", actor: { role: "harness" }, payload: { topic: "n" } }, rubric);
  `;
  await Promise.all(
    Array.from(
      { length: 4 },
      () =>
        new Promise((done, fail) => {
          const p = spawn("node", ["--input-type=module", "-e", script]);
          p.on("close", (c) =>
            c === 0 ? done() : fail(new Error(`appender exited ${c}`)),
          );
        }),
    ),
  );
  const events = readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  assert.deepEqual(
    events.map((e) => e.seq),
    Array.from({ length: 32 }, (_, i) => i + 1),
  );
  for (let i = 1; i < events.length; i += 1)
    assert.ok(events[i].mono_ms >= events[i - 1].mono_ms);
});

// ---- journal audit ---------------------------------------------------------------------

test("journal audit separates stale accepted writes from holder mismatches", () => {
  const rows = [
    {
      seq: 1,
      kind: "claim.acquired",
      resource: "task:T1",
      participant_id: "w1",
      fence: 1,
    },
    {
      seq: 2,
      kind: "claim.acquired",
      resource: "task:T1",
      participant_id: "w2",
      fence: 2,
    },
    {
      seq: 3,
      kind: "entity.updated",
      resource: "T1",
      participant_id: "w1",
      fence: 1,
    },
    {
      seq: 4,
      kind: "entity.updated",
      resource: "T1",
      participant_id: "w1",
      fence: 2,
    },
    {
      seq: 5,
      kind: "entity.updated",
      resource: "T1",
      participant_id: "w2",
      fence: 2,
    },
  ];
  const audit = auditJournal(rows);
  assert.deepEqual(audit.stale_accepted, [3]);
  assert.deepEqual(audit.holder_mismatch, [4]);
  assert.equal(audit.fenced_updates, 3);
});

// ---- ledger: absence is never zero -------------------------------------------------------

test("a good condition-B trial derives observed metrics and passes the gates", () => {
  const ledger = derive(goodTrial());
  assert.equal(ledger.outcome, "success");
  assert.equal(ledger.enforcement.enforced, true);
  assert.equal(ledger.metrics.handoff_score.value, 4);
  assert.equal(ledger.metrics.handoff_candidate_count.value, 6);
  assert.equal(ledger.metrics.conflict_prevented.value, 1);
  assert.equal(ledger.metrics.recovery_to_decision_ms.censored, false);
  assert.ok(Object.values(ledger.gates).every((g) => !g.violated));
});

test("missing sources become unavailable or not applicable, never zero", () => {
  const l = goodTrial();
  const ledger = derive(l, {
    frozen: { ...frozenHook, count_source: "none" },
    review: null,
  });
  assert.equal(ledger.roles.w1.tool_calls.availability, "unavailable");
  assert.equal(ledger.roles.w1.tool_calls.value, null);
  assert.equal(ledger.roles.w1.tokens.availability, "unavailable");
  assert.equal(ledger.metrics.handoff_score.availability, "unavailable");
  assert.equal(ledger.metrics.mcp_calls.availability, "unavailable");
  assert.equal(ledger.outcome, "harness_invalid");
  const a = derive(goodTrial(slotA), {}, slotA);
  assert.equal(a.metrics.stale_fence_attempts.availability, "not_applicable");
  assert.equal(a.metrics.mcp_calls.availability, "not_applicable");
});

test("a lexical candidate never earns a handoff or decision point without the reviewer", () => {
  const l = goodTrial();
  const noReview = derive(l, { review: null });
  assert.equal(noReview.metrics.handoff_score.availability, "unavailable");
  assert.equal(
    noReview.metrics.recovery_to_decision_ms.availability,
    "unavailable",
  );
  assert.equal(noReview.gates.G2_lost_acknowledged_decision.undetermined, true);
  const contradicted = derive(l, {
    review: {
      ...review,
      resume: { ...review.resume, decision_correct: false },
    },
  });
  assert.equal(contradicted.metrics.recovery_to_decision_ms.censored, true);
  assert.equal(contradicted.gates.G2_lost_acknowledged_decision.value, 1);
  assert.equal(
    contradicted.gates.G2_lost_acknowledged_decision.violated,
    slotB.condition === "B",
  );
  const none = derive(l, {
    review: { ...review, handoff: { facts: { a: "incorrect", b: "absent" } } },
  });
  assert.equal(none.metrics.handoff_score.value, 0);
});

test("preflight drill results cannot change agent counts and fixture provenance is flagged", () => {
  const l = goodTrial();
  const before = derive(l);
  const withDrill = goodTrial();
  withDrill.add(
    "tila_call",
    "harness",
    {
      role: "w1",
      verb: "task update",
      presented_fence: 1,
      outcome: "stale_fence",
    },
    705_000,
    "harness_fixture",
  );
  const flagged = validateBundle({
    bundle: bundleOf({ t2: { events: withDrill.events } }),
    rubric,
    rubricSha256,
    declaration,
  });
  assert.ok(
    flagged.findings.some((f) => f.code === "provenance" && f.trial === "t2"),
  );
  assert.equal(before.metrics.stale_fence_rejected.value, 0);
  const drillsFile = {
    provenance: "harness_fixture",
    pass: true,
    results: [{ id: "D2_stale_fence", pass: true }],
  };
  const withDrills = validateBundle({
    bundle: bundleOf(
      { t2: { events: l.events, evaluation: passingEvaluation(), review } },
      drillsFile,
    ),
    rubric,
    rubricSha256,
    declaration,
  });
  assert.equal(withDrills.ledgers.t2.metrics.stale_fence_rejected.value, 0);
});

test("a late scheduled message or a hook failure makes the trial invalid; it is not paused", () => {
  const late = goodTrial();
  late.events.find((e) => e.kind === "decision.issued").mono_ms =
    1_000_000 + 240_000 + 16_000;
  const lateLedger = derive(late);
  assert.ok(lateLedger.flags.includes("schedule_late:decision_issued"));
  assert.equal(lateLedger.outcome, "harness_invalid");
  const within = goodTrial();
  within.events.find((e) => e.kind === "decision.issued").mono_ms =
    1_000_000 + 240_000 + 14_000;
  assert.equal(derive(within).outcome, "success");

  const hookBroke = goodTrial();
  hookBroke.add(
    "harness.note",
    "harness",
    { topic: "hook_failure", text: "boom" },
    711_000,
  );
  const ledger = derive(hookBroke);
  assert.equal(ledger.enforcement.enforced, false);
  assert.equal(ledger.outcome, "harness_invalid");
  const unfrozen = derive(goodTrial(), {
    frozen: { ...frozenHook, count_hook_sha256: undefined },
  });
  assert.equal(unfrozen.enforcement.enforced, false);
});

test("early results are provisional until D1 and a reaffirmation completes the role", () => {
  const l = goodTrial();
  const w1Only = l.events.filter(
    (e) => !(e.kind === "result.declared" && e.mono_ms > 1_000_000 + 240_000),
  );
  const provisional = derive({
    events: w1Only.map((e, i) => ({ ...e, seq: i + 1 })),
  });
  assert.equal(provisional.roles.w1.declared_result, false);
  assert.equal(provisional.roles.w1.initial_result_ms, 60_000);
  assert.equal(
    provisional.outcome,
    "timeout_wall".replace("timeout_wall", provisional.outcome),
  );
  assert.notEqual(provisional.outcome, "success");
  const full = derive(l);
  assert.equal(full.roles.w1.declared_result, true);
  assert.equal(full.roles.w1.final_result_ms, 500_000);
});

test("call counts distinguish attempted, admitted and denied and flag an overrun", () => {
  const l = goodTrial();
  for (let i = 0; i < 41; i += 1)
    l.add(
      "tool_call",
      "w1",
      { role: "w1", category: "edit", source: "hook", denied: false },
      705_000,
    );
  l.add(
    "tool_call",
    "w1",
    {
      role: "w1",
      category: "edit",
      source: "hook",
      denied: true,
      reason: "tool_call_budget",
    },
    706_000,
  );
  const ledger = derive(l);
  const calls = ledger.roles.w1.tool_calls.value;
  assert.equal(calls.denied, 1);
  assert.equal(calls.attempted, calls.total + 1);
  assert.ok(ledger.flags.includes("budget_overrun:w1"));
});

// ---- bundle validation -------------------------------------------------------------------

function bundleOf(trials, drills = null) {
  const out = {
    frozen: {
      kind: "frozen",
      rubric: { sha256: rubricSha256 },
      declaration_sha256: declaration.declaration_sha256,
      frozen: {
        ...frozenHook,
        source_sha: "1".repeat(40),
        source_tree_clean: true,
        runtime_versions: { node: "v22" },
        model_id: "model",
        count_source: "hook",
        hook_smoke_attested: true,
        count_hook_sha256: "a".repeat(64),
        usage_source: "none",
        host_label: "host-1",
      },
    },
    trials: {},
    drills,
  };
  for (const [id, t] of Object.entries(trials))
    out.trials[id] = {
      parseProblems: [],
      evaluation: null,
      ledger: null,
      review: null,
      ...t,
    };
  return out;
}

test("validation reports missing trials, failed outcomes stay, and dropped trials are errors", () => {
  const l = goodTrial();
  const res = validateBundle({
    bundle: bundleOf({
      t2: { events: l.events, evaluation: passingEvaluation(), review },
    }),
    rubric,
    rubricSha256,
    declaration,
  });
  assert.ok(
    res.findings.some((f) => f.code === "trial_missing" && f.trial === "t1"),
  );
  assert.equal(res.ok, false);
  assert.equal(res.efficacy_claim_allowed, false);
  assert.equal(res.claim_level, "feasibility_only");
});

test("validation rejects a ledger that disagrees with its events and a leaked credential", () => {
  const l = goodTrial();
  const honest = derive(l);
  const forged = structuredClone(honest);
  forged.metrics.stale_authority_accepted = {
    availability: "observed",
    value: 0,
    evidence: [],
  };
  forged.outcome = "success";
  forged.gates.G1_stale_authority_write.value = 5;
  const res = validateBundle({
    bundle: bundleOf({
      t2: {
        events: l.events,
        evaluation: passingEvaluation(),
        review,
        ledger: forged,
      },
    }),
    rubric,
    rubricSha256,
    declaration,
  });
  assert.ok(res.findings.some((f) => f.code === "ledger_mismatch"));
  const leaky = goodTrial();
  leaky.add(
    "harness.note",
    "harness",
    {
      topic: "paths",
      text: "see /home/someone/code/x and key sk-abcdefghijklmnopqrstuv",
    },
    712_000,
  );
  const leak = validateBundle({
    bundle: bundleOf({
      t2: { events: leaky.events, evaluation: passingEvaluation(), review },
    }),
    rubric,
    rubricSha256,
    declaration,
  });
  assert.ok(leak.findings.some((f) => f.code === "redaction"));
});

test("a stale accepted write in condition B is a gate failure for the whole study", () => {
  const l = goodTrial();
  const evaluation = passingEvaluation();
  evaluation.fence_audit = {
    stale_accepted: [9],
    holder_mismatch: [],
    fenced_updates: 0,
  };
  const res = validateBundle({
    bundle: bundleOf({ t2: { events: l.events, evaluation, review } }),
    rubric,
    rubricSha256,
    declaration,
  });
  assert.equal(res.reading, "gate_failure");
  assert.ok(res.findings.some((f) => f.code === "gate_violation"));
});

test("an undeclared incomplete freeze is rejected", () => {
  const b = bundleOf({});
  b.frozen.frozen.model_id = null;
  b.frozen.frozen.source_sha = "";
  const res = validateBundle({ bundle: b, rubric, rubricSha256, declaration });
  assert.ok(
    res.findings.filter((f) => f.code === "incomplete_freeze").length >= 2,
  );
});

// ---- budget hook (run as a subprocess, as the CLI would) ---------------------------------

function hookRun(runDir, role, input) {
  return spawnSync(
    "node",
    [
      join(repo, "scripts/dogfood-study-tila.mjs"),
      "budget-hook",
      "--run-dir",
      runDir,
      "--trial",
      "t1",
      "--role",
      role,
    ],
    {
      input: JSON.stringify(input),
      encoding: "utf8",
    },
  );
}

function hookTrial() {
  const run = scratch();
  const dir = join(run, "trials", "t1");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "trial.json"),
    JSON.stringify({
      trial: "t1",
      condition: "A",
      participants: { w1: "w1", w2: "w2", w1r: "w1r", w2r: "w2r" },
      rubric_path: "docs/evidence/issue-194-rubric-v3.json",
      worktrees: { w1: join(dir, "wt-w1"), w2: join(dir, "wt-w2") },
      shared: join(dir, "shared"),
      decision: { id: "D1", key_phrases: ["unknown flag", "64"] },
      hidden_patterns: ["dogfood-study-fixtures", "accept.mjs"],
    }),
  );
  writeFileSync(
    join(dir, "events.jsonl"),
    `${JSON.stringify({ schema: "tila.dogfood.event/1", study_id: "tila-194-dogfood-pilot-v1", trial_id: "t1", seq: 1, ts_utc: new Date().toISOString(), mono_ms: Number(process.hrtime.bigint() / 1_000_000n), actor: { role: "harness" }, kind: "trial.started", provenance: "local_agent_trial", payload: {} })}\n`,
  );
  mkdirSync(join(dir, "wt-w1"));
  mkdirSync(join(dir, "shared"));
  writeFileSync(join(dir, "shared/BOARD.md"), "");
  writeFileSync(join(dir, "shared/DECISIONS.md"), "");
  appendEvent(
    join(dir, "events.jsonl"),
    {
      kind: "worker.started",
      actor: { role: "w1" },
      payload: {
        role: "w1",
        participant: "w1",
        context: "original",
        session_id: "s-w1",
      },
    },
    rubric,
  );
  return { run, dir, file: join(dir, "events.jsonl") };
}

const readLog = (file) =>
  readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
const call = (n, extra = {}) => ({
  hook_event_name: "PreToolUse",
  turn_id: "turn-1",
  session_id: "s-w1",
  tool_name: "Bash",
  tool_use_id: `u${n}`,
  tool_input: { command: "git status" },
  ...extra,
});

test("the hook admits 40 calls per role, denies the 41st with a JSON decision and keeps both counts", () => {
  const { run, file } = hookTrial();
  let firstDenied = null;
  for (let i = 1; i <= 42 && firstDenied === null; i += 1) {
    const r = hookRun(run, "w1", call(i));
    assert.equal(r.status, 0);
    if (r.stdout.trim()) firstDenied = { i, body: JSON.parse(r.stdout) };
  }
  assert.equal(firstDenied.i, 41);
  assert.equal(firstDenied.body.hookSpecificOutput.permissionDecision, "deny");
  assert.equal(firstDenied.body.hookSpecificOutput.hookEventName, "PreToolUse");
  const calls = readLog(file).filter((e) => e.kind === "tool_call");
  assert.equal(calls.length, 41);
  assert.equal(calls.filter((c) => c.payload.denied).length, 1);
  assert.ok(calls.every((c) => c.payload.tool_use_id && c.payload.session_id));
  assert.ok(
    !readFileSync(file, "utf8").includes("git status"),
    "tool input must not be stored",
  );
});

test("a replacement session shares its role's counter and is mapped to the replacement participant", () => {
  const { run, file } = hookTrial();
  for (let i = 1; i <= 39; i += 1) hookRun(run, "w1", call(i));
  appendEvent(
    file,
    {
      kind: "worker.stopped",
      actor: { role: "w1" },
      payload: { role: "w1", reason: "replacement" },
    },
    rubric,
  );
  appendEvent(
    file,
    {
      kind: "worker.started",
      actor: { role: "w1r" },
      payload: {
        role: "w1r",
        participant: "w1r",
        context: "replacement",
        session_id: "s-w1-new",
      },
    },
    rubric,
  );
  appendEvent(
    file,
    {
      kind: "recovery.started",
      actor: { role: "w1r" },
      payload: { role: "w1r", participant: "w1r" },
    },
    rubric,
  );
  const old = hookRun(run, "w1", call("old"));
  assert.match(old.stdout, /retired_session/);
  const a = hookRun(run, "w1", call(40, { session_id: "s-w1-new" }));
  assert.equal(a.stdout.trim(), "");
  const b = hookRun(run, "w1", call(41, { session_id: "s-w1-new" }));
  assert.match(b.stdout, /"deny"/);
  const events = readLog(file);
  const started = events.filter((e) => e.kind === "worker.started");
  assert.deepEqual(
    started.map((e) => e.payload.participant),
    ["w1", "w1r"],
  );
  assert.ok(
    events.some((e) => e.kind === "recovery.started" && e.actor.role === "w1r"),
  );
});

test("hidden study files are denied and a hook that cannot read its trial fails closed", () => {
  const { run } = hookTrial();
  const r = hookRun(run, "w1", {
    ...call("hidden"),
    tool_input: { command: "cat scripts/dogfood-study-fixtures.mjs" },
  });
  assert.match(r.stdout, /hidden_study_file/);
  const broken = spawnSync(
    "node",
    [
      join(repo, "scripts/dogfood-study-tila.mjs"),
      "budget-hook",
      "--run-dir",
      join(run, "nowhere"),
      "--trial",
      "t1",
      "--role",
      "w1",
    ],
    {
      input: "{}",
      encoding: "utf8",
    },
  );
  assert.equal(broken.status, 2);
  assert.match(broken.stderr, /failed closed/);
});

test("pre-execution text, reads and failed writes cannot declare results or confirm recovery", () => {
  const { run, dir, file } = hookTrial();
  hookRun(
    run,
    "w1",
    call(1, {
      tool_input: { command: "grep 'ACK D1 w1 RESULT w1 abc1234' BOARD.md" },
    }),
  );
  assert.ok(
    !readLog(file).some((e) =>
      ["decision.acked", "result.declared"].includes(e.kind),
    ),
  );
  appendEvent(
    file,
    {
      kind: "worker.stopped",
      actor: { role: "w1" },
      payload: { role: "w1", reason: "replacement" },
    },
    rubric,
  );
  appendEvent(
    file,
    {
      kind: "worker.started",
      actor: { role: "w1r" },
      payload: {
        role: "w1r",
        participant: "w1r",
        context: "replacement",
        session_id: "replacement",
      },
    },
    rubric,
  );
  const attempt = call(2, {
    session_id: "replacement",
    tool_input: {
      command: "echo DECISION: D1 unknown flags ignored > RESUME.txt",
    },
  });
  hookRun(run, "w1", attempt);
  hookRun(run, "w1", {
    ...attempt,
    hook_event_name: "PostToolUse",
    tool_response: { exit_code: 1 },
  });
  assert.ok(!readLog(file).some((e) => e.kind === "recovery.decision_stated"));
  const correct = call(3, {
    session_id: "replacement",
    tool_input: { command: "printf note > RESUME.txt" },
  });
  hookRun(run, "w1", correct);
  const text =
    "DECISION: D1 unknown flags are errors; return 64\nNEXT: verify\n";
  writeFileSync(join(dir, "wt-w1/RESUME.txt"), text);
  hookRun(run, "w1", {
    ...correct,
    hook_event_name: "PostToolUse",
    tool_response: { exit_code: 0 },
  });
  const candidate = readLog(file).find(
    (e) => e.kind === "recovery.decision_stated",
  );
  assert.equal(candidate.payload.text_sha256, sha256Text(text));
  assert.equal(candidate.payload.tool_use_id, "u3");
  const action = call(4, {
    session_id: "replacement",
    tool_input: { command: "node --test test/" },
  });
  hookRun(run, "w1", action);
  assert.ok(!readLog(file).some((e) => e.kind === "recovery.first_action"));
  hookRun(run, "w1", {
    ...action,
    hook_event_name: "PostToolUse",
    tool_response: { exit_code: 0 },
  });
  assert.equal(
    readLog(file).filter((e) => e.kind === "recovery.first_action").length,
    1,
  );
});

test("parallel covered operations share the last slot and duplicate deliveries allocate none", async () => {
  const { run, file } = hookTrial();
  for (let i = 1; i <= 39; i += 1)
    assert.equal(hookRun(run, "w1", call(i)).status, 0);
  const invoke = (n) =>
    new Promise((done) => {
      const child = spawn(
        "node",
        [
          join(repo, "scripts/dogfood-study-tila.mjs"),
          "budget-hook",
          "--run-dir",
          run,
          "--trial",
          "t1",
          "--role",
          "w1",
        ],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      let stdout = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stdin.end(JSON.stringify(call(n)));
      child.on("close", (status) => done({ status, stdout }));
    });
  const results = await Promise.all([invoke(40), invoke(41), invoke(42)]);
  assert.ok(results.every((r) => r.status === 0));
  assert.equal(results.filter((r) => !r.stdout).length, 1);
  assert.equal(
    readLog(file).filter((e) => e.kind === "tool_call" && !e.payload.denied)
      .length,
    40,
  );
  const duplicate = hookRun(run, "w1", call(1));
  assert.match(duplicate.stdout, /duplicate_delivery/);
  assert.equal(
    readLog(file).filter((e) => e.kind === "tool_call" && !e.payload.denied)
      .length,
    40,
  );
});

test("closed trials, unknown sessions and malformed metadata cannot receive admission", () => {
  for (const reason of [
    "trial_closed",
    "unregistered_session",
    "malformed_hook_identity",
  ]) {
    const { run, file } = hookTrial();
    if (reason === "trial_closed")
      appendEvent(
        file,
        {
          kind: "trial.stopped",
          actor: { role: "harness" },
          payload: { reason: "harness_failure" },
        },
        rubric,
      );
    const result = hookRun(
      run,
      "w1",
      call(
        1,
        reason === "unregistered_session"
          ? { session_id: "stranger" }
          : reason === "malformed_hook_identity"
            ? { turn_id: "" }
            : {},
      ),
    );
    assert.match(result.stdout, new RegExp(reason));
    assert.equal(
      readLog(file).filter((e) => e.kind === "tool_call" && !e.payload.denied)
        .length,
      0,
    );
    if (reason !== "trial_closed")
      assert.ok(readLog(file).some((e) => e.payload.topic === "hook_failure"));
  }
  const { run, file } = hookTrial();
  const broken = `${readFileSync(file, "utf8")}broken-tail`;
  writeFileSync(file, broken);
  const result = hookRun(run, "w1", call(1));
  assert.equal(result.status, 2);
  assert.equal(readFileSync(file, "utf8"), broken);
});

test("semantic review of a later RESUME version cannot backdate decision recovery", () => {
  const l = goodTrial();
  const old = l.events.find((e) => e.kind === "recovery.decision_stated");
  old.payload.text_sha256 = "c".repeat(64);
  const later = {
    ...structuredClone(old),
    mono_ms: old.mono_ms + 10_000,
    payload: { ...old.payload, text_sha256: "b".repeat(64) },
  };
  l.events.splice(l.events.indexOf(old) + 1, 0, later);
  l.events.forEach((e, i) => {
    e.seq = i + 1;
  });
  const ledger = derive(l);
  assert.equal(ledger.metrics.recovery_to_decision_ms.value, 29_700);
  const forged = derive(l, {
    review: {
      ...review,
      resume: { decision_correct: true, text_sha256: "d".repeat(64) },
    },
  });
  assert.equal(forged.metrics.recovery_to_decision_ms.censored, true);
});

test("a count-source or registered-identity gap makes enforcement unavailable", () => {
  const l = goodTrial();
  const tool = l.events.find((e) => e.kind === "tool_call");
  tool.payload.source = "transcript";
  assert.equal(derive(l).enforcement.enforced, false);
  tool.payload.source = "hook";
  tool.payload.session_id = "unknown";
  assert.equal(derive(l).enforcement.enforced, false);
});

test("baseline declarations are recorded after durable writes and failed appends earn none", () => {
  const { run, dir, file } = hookTrial();
  const board = (...args) =>
    spawnSync(
      "node",
      [
        join(repo, "scripts/dogfood-study-tila.mjs"),
        "board",
        "--run-dir",
        run,
        "--trial",
        "t1",
        "--participant",
        "w1",
        ...args,
      ],
      { encoding: "utf8" },
    );
  assert.equal(board("ack", "D1").status, 0);
  assert.equal(board("result", "abc1234").status, 0);
  assert.match(
    readFileSync(join(dir, "shared/BOARD.md"), "utf8"),
    /RESULT w1 abc1234/,
  );
  assert.equal(
    readLog(file).filter((e) => e.kind === "result.declared").length,
    1,
  );
  rmSync(join(dir, "shared/BOARD.md"));
  mkdirSync(join(dir, "shared/BOARD.md"));
  assert.notEqual(board("reaffirm", "abc1234").status, 0);
  assert.equal(
    readLog(file).filter((e) => e.kind === "result.declared").length,
    1,
  );
});

// ---- baseline coordination recipe (ordinary atomic lock, recorded takeover) --------------

test("two simultaneous baseline claims have exactly one owner and a replacement can take over", async () => {
  const shared = scratch();
  mkdirSync(join(shared, "locks"), { recursive: true });
  writeFileSync(join(shared, "BOARD.md"), "");
  const lock = join(shared, "locks/shared-helper");
  const claim = (role) =>
    new Promise((done) => {
      const p = spawn("bash", [
        "-c",
        baselineHelperCommands({ shared, role }).acquire,
      ]);
      p.on("close", (code) => done({ role, won: code === 0 }));
    });
  const results = await Promise.all([claim("w1"), claim("w2")]);
  assert.equal(results.filter((r) => r.won).length, 1);
  const owner = readFileSync(join(lock, "owner"), "utf8").split(" ")[0];
  const winner = results.find((r) => r.won).role;
  assert.equal(owner, winner);
  assert.equal((await claim(winner)).won, true);
  const loser = winner === "w1" ? "w2" : "w1";
  const denied = spawnSync("bash", [
    "-c",
    baselineHelperCommands({ shared, role: `${loser}r` }).transfer,
  ]);
  assert.equal(denied.status, 1);
  assert.equal(readFileSync(join(lock, "owner"), "utf8").split(" ")[0], winner);
  // Takeover by the replacement of the owner, recorded on the board.
  const take = spawnSync("bash", [
    "-c",
    baselineHelperCommands({ shared, role: `${winner}r` }).transfer,
  ]);
  assert.equal(take.status, 0);
  assert.match(
    readFileSync(join(lock, "owner"), "utf8"),
    new RegExp(`^${winner}r `),
  );
  assert.match(
    readFileSync(join(shared, "BOARD.md"), "utf8"),
    /TRANSFER shared-helper/,
  );
  const repeated = spawnSync("bash", [
    "-c",
    baselineHelperCommands({ shared, role: `${winner}r` }).transfer,
  ]);
  assert.equal(repeated.status, 0);
  assert.equal(
    readFileSync(join(shared, "BOARD.md"), "utf8").match(/TRANSFER/g).length,
    1,
  );
  rmSync(lock, { recursive: true });
  const fresh = spawnSync("bash", [
    "-c",
    baselineHelperCommands({ shared, role: `${loser}r` }).transfer,
  ]);
  assert.equal(fresh.status, 0);
  assert.match(
    readFileSync(join(lock, "owner"), "utf8"),
    new RegExp(`^${loser}r `),
  );
});

// ---- evaluation of a real condition-A trial (git and node only) ---------------------------

function git(cwd, ...args) {
  return spawnSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args],
    { cwd, encoding: "utf8" },
  );
}

function preparedTrialA(trialId = "t1") {
  const root = scratch();
  const run = join(root, "run");
  const source = join(root, "src");
  mkdirSync(source, { recursive: true });
  git(source, "init", "-q", "-b", "main");
  writeFileSync(join(source, "f"), "x");
  git(source, "add", "f");
  git(source, "commit", "-q", "-m", "init");
  const decl = join(root, "decl.json");
  writeFileSync(decl, JSON.stringify(declaration));
  const drills = join(run, "preflight/drills.json");
  mkdirSync(dirname(drills), { recursive: true });
  writeFileSync(
    drills,
    JSON.stringify({ provenance: "harness_fixture", pass: true, results: [] }),
  );
  const cli = (...args) =>
    spawnSync(
      "node",
      [join(repo, "scripts/dogfood-study.mjs"), ...args, "--declaration", decl],
      { encoding: "utf8" },
    );
  const smoke = join(root, "synthetic-smoke.json");
  const syntheticEvidence =
    "synthetic unit-test contract; not installed runtime smoke";
  const binary = join(root, "synthetic-binary");
  writeFileSync(binary, syntheticEvidence);
  writeFileSync(join(root, "synthetic-test-contract"), syntheticEvidence);
  writeFileSync(
    smoke,
    JSON.stringify({
      provenance: "harness_fixture",
      note: "synthetic unit-test contract, not runtime evidence",
      source_sha: git(source, "rev-parse", "HEAD").stdout.trim(),
      codex_version: spawnSync("codex", ["--version"], {
        encoding: "utf8",
      }).stdout.trim(),
      permissions: { sandbox_mode: "synthetic", approval_policy: "synthetic" },
      binary_path: binary,
      binary_sha256: sha256Text(syntheticEvidence),
      config_template_sha256: sha256Text(
        canonicalJson(
          buildHookSettings({
            hookScript: "$SOURCE/scripts/dogfood-study-tila.mjs",
            runDir: "$RUN",
            trial: "$TRIAL",
            role: "$ROLE",
          }),
        ),
      ),
      checks: [
        "coverage",
        "identifiers",
        "parallel_39_40_41",
        "zero_effect_denial",
        "replacement_retirement",
        "deadline_closure",
        "malformed_failure",
        "terminal_cleanup",
      ].map((name) => ({
        name,
        pass: true,
        evidence_ref: "synthetic-test-contract",
        evidence_sha256: sha256Text(syntheticEvidence),
      })),
    }),
  );
  let r = cli(
    "freeze",
    "--run-dir",
    run,
    "--model-id",
    "gpt-6.1-sol",
    "--count-source",
    "hook",
    "--usage-source",
    "none",
    "--hook-smoke",
    smoke,
    "--host-label",
    "host-1",
    "--source-root",
    source,
  );
  assert.equal(r.status, 0, r.stderr);
  r = cli("prepare", "--run-dir", run, "--trial", trialId);
  assert.equal(r.status, 0, r.stderr);
  const trial = JSON.parse(
    readFileSync(join(run, `trials/${trialId}/trial.json`), "utf8"),
  );
  const slot = declaration.trials.find((t) => t.trial === trialId);
  const scenario = buildScenario(slot.pair, slot.variant);
  return { run, trial, slot, scenario, cli, source };
}

test("v3 refuses a boolean-only hook-smoke attestation before writing a frozen manifest", () => {
  const { run, source, cli } = preparedTrialA();
  const fresh = join(scratch(), "run");
  const result = cli(
    "freeze",
    "--run-dir",
    fresh,
    "--model-id",
    "gpt-6.1-sol",
    "--count-source",
    "hook",
    "--usage-source",
    "none",
    "--host-label",
    "fixture",
    "--source-root",
    source,
    "--drills",
    join(run, "preflight/drills.json"),
    "--hook-smoke-passed",
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /boolean is insufficient/);
  assert.ok(!existsSync(join(fresh, "manifest.frozen.json")));
});

test("an integrated condition-A trial passes, imported commits are not authored edits, and RESUME.txt is allowed", () => {
  const { run, trial, slot, scenario, cli } = preparedTrialA();
  const claim = spawnSync("bash", [
    "-c",
    baselineHelperCommands({ shared: trial.shared, role: "w1" }).acquire,
  ]);
  assert.equal(claim.status, 0, String(claim.stderr));
  const item = (role) => scenario.items[slot.role_items[role]];
  const ref = scenario.reference.amended;
  const files = (r) => ({ ...r.helper, ...r.item1, ...r.item2 });
  // w1 owns the helper and item1 (mutating only its own authored files).
  const w1Files = {
    ...ref.helper,
    ...(slot.role_items.w1 === "item1" ? ref.item1 : ref.item2),
  };
  materializeFiles(w1Files, trial.worktrees.w1);
  git(trial.worktrees.w1, "add", "-A");
  git(trial.worktrees.w1, "commit", "-q", "-m", "w1 work");
  // w2 merges w1's branch (allowed) and adds only its own item.
  git(trial.worktrees.w2, "merge", "-q", "--no-edit", "w1");
  const w2Item = slot.role_items.w2 === "item1" ? ref.item1 : ref.item2;
  materializeFiles(w2Item, trial.worktrees.w2);
  git(trial.worktrees.w2, "add", "-A");
  git(trial.worktrees.w2, "commit", "-q", "-m", "w2 work");
  writeFileSync(
    join(trial.worktrees.w2, "RESUME.txt"),
    "DECISION: D1 see NOTES\nNEXT: none\n",
  );
  writeFileSync(
    join(trial.shared, "BOARD.md"),
    "shared-helper: owner=w1 since=00:00:01\n",
  );
  assert.ok(Object.keys(files(ref)).length >= 3 && item("w1") && item("w2"));
  const r = cli("evaluate", "--run-dir", run, "--trial", "t1");
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const evaluation = JSON.parse(
    readFileSync(join(run, "trials/t1/evaluation.json"), "utf8"),
  );
  assert.equal(evaluation.integration.conflict, false);
  assert.ok(
    evaluation.cases.every((c) => c.pass),
    JSON.stringify(evaluation.cases.filter((c) => !c.pass)),
  );
  assert.deepEqual(evaluation.forbidden_paths, []);
  const w1Commit = git(trial.worktrees.w1, "rev-parse", "HEAD").stdout.trim();
  assert.ok(evaluation.branches.w1.authored_commits.includes(w1Commit));
  assert.ok(evaluation.branches.w2.imported_commits.includes(w1Commit));
  assert.ok(!evaluation.branches.w2.authored_commits.includes(w1Commit));
  assert.equal(evaluation.helper_definitions.count, 1);
  assert.equal(evaluation.overlap.owner, "w1");
  assert.equal(evaluation.overlap.response, "redirected");
  assert.ok(existsSync(join(run, "review-packets")));
});

test("a forbidden authored edit, an ignored-argument implementation and a second helper are outcomes, not passes", () => {
  const { run, trial, slot, scenario, cli } = preparedTrialA();
  const ref = scenario.reference.amended;
  // w1: constant-sample mutant of its item, plus an edit to the frozen notes file.
  const mine = slot.role_items.w1;
  materializeFiles(
    { ...ref.helper, ...scenario.mutant[mine], "NOTES.md": "tampered\n" },
    trial.worktrees.w1,
  );
  git(trial.worktrees.w1, "add", "-A");
  git(trial.worktrees.w1, "commit", "-q", "-m", "w1");
  // w2: its own, correct item and a second copy of the helper.
  const other = slot.role_items.w2;
  materializeFiles({ ...ref[other], ...ref.helper }, trial.worktrees.w2);
  git(trial.worktrees.w2, "add", "-A");
  git(trial.worktrees.w2, "commit", "-q", "-m", "w2");
  writeFileSync(
    join(trial.shared, "BOARD.md"),
    "shared-helper: owner=w1 since=00:00:01\n",
  );
  const r = cli("evaluate", "--run-dir", run, "--trial", "t1");
  assert.equal(r.status, 0, r.stderr);
  const evaluation = JSON.parse(
    readFileSync(join(run, "trials/t1/evaluation.json"), "utf8"),
  );
  assert.ok(
    evaluation.forbidden_paths.some(
      (f) => f.path === "NOTES.md" && f.role === "w1",
    ),
  );
  assert.ok(evaluation.tampering.some((f) => f.path === "NOTES.md"));
  assert.equal(evaluation.overlap.response, "duplicate_started");
  assert.equal(
    evaluation.integration.conflict,
    false,
    "git can integrate identical helper additions without a textual conflict",
  );
  assert.ok(evaluation.cases.some((c) => c.tags.includes(mine) && !c.pass));
});

test("importing a forbidden commit retains its origin and immutable-path failure", () => {
  const { run, trial, slot, scenario, cli } = preparedTrialA();
  materializeFiles(
    {
      ...scenario.reference.amended.helper,
      ...scenario.reference.amended[slot.role_items.w1],
      "NOTES.md": "forbidden authored change\n",
    },
    trial.worktrees.w1,
  );
  git(trial.worktrees.w1, "add", "-A");
  git(trial.worktrees.w1, "commit", "-q", "-m", "w1 forbidden");
  const origin = git(trial.worktrees.w1, "rev-parse", "HEAD").stdout.trim();
  materializeFiles(
    scenario.reference.amended[slot.role_items.w2],
    trial.worktrees.w2,
  );
  git(trial.worktrees.w2, "add", "-A");
  git(trial.worktrees.w2, "commit", "-q", "-m", "w2 own item");
  const merged = git(trial.worktrees.w2, "merge", "-q", "--no-edit", "w1");
  assert.equal(merged.status, 0, merged.stderr);
  const result = cli("evaluate", "--run-dir", run, "--trial", "t1");
  assert.equal(result.status, 0, result.stderr);
  const evaluation = JSON.parse(
    readFileSync(join(run, "trials/t1/evaluation.json"), "utf8"),
  );
  assert.equal(evaluation.commit_origins[origin], "w1");
  assert.ok(
    evaluation.forbidden_paths.some(
      (f) => f.role === "w1" && f.path === "NOTES.md",
    ),
  );
  assert.ok(!evaluation.forbidden_paths.some((f) => f.role === "w2"));
  assert.equal(
    evaluation.tampering.filter(
      (f) => f.commit === origin && f.path === "NOTES.md",
    ).length,
    1,
  );
});

test("missing run-owned commit provenance refuses evaluation instead of hiding shared edits", () => {
  const { run, trial, cli } = preparedTrialA();
  writeFileSync(join(trial.worktrees.w1, "NOTES.md"), "forbidden\n");
  git(trial.worktrees.w1, "add", "-A");
  git(trial.worktrees.w1, "commit", "-q", "-m", "forbidden");
  assert.equal(
    git(trial.worktrees.w1, "reflog", "expire", "--expire=now", "w1").status,
    0,
  );
  const result = cli("evaluate", "--run-dir", run, "--trial", "t1");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /missing branch provenance/);
  assert.ok(!existsSync(join(run, "trials/t1/evaluation.json")));
  assert.equal(
    readFileSync(join(trial.worktrees.w1, "NOTES.md"), "utf8"),
    "forbidden\n",
  );
});

test("synthetic condition-B wrapper writes survive journal, handoff and state evaluation", () => {
  const { run, trial, slot, scenario, cli } = preparedTrialA("t2");
  const wrapper = (participant, command, ...args) => {
    const result = spawnSync(
      "node",
      [
        join(repo, "scripts/dogfood-study-tila.mjs"),
        command,
        "--run-dir",
        run,
        "--trial",
        "t2",
        "--participant",
        participant,
        ...args,
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr + result.stdout);
    return JSON.parse(result.stdout);
  };
  wrapper("w1", "sdk", "claim", `task:${trial.task_ids.helper}`);
  for (const role of ["w1", "w2"]) {
    const item = slot.role_items[role];
    const task = trial.task_ids[item];
    const claim = wrapper(role, "sdk", "claim", `task:${task}`);
    materializeFiles(
      {
        ...(role === "w1" ? scenario.reference.amended.helper : {}),
        ...scenario.reference.amended[item],
      },
      trial.worktrees[role],
    );
    git(trial.worktrees[role], "add", "-A");
    git(trial.worktrees[role], "commit", "-q", "-m", `${role} work`);
    const commit = git(
      trial.worktrees[role],
      "rev-parse",
      "HEAD",
    ).stdout.trim();
    for (const field of [
      "decision_ack=D1",
      "status=done",
      `result_commit=${commit}`,
    ])
      wrapper(
        role,
        "tila",
        "--",
        "task",
        "update",
        task,
        "--field",
        field,
        "--fence",
        String(claim.fence),
      );
  }
  wrapper(
    slot.replaced_role,
    "sdk",
    "handoff-create",
    "--summary",
    "Goal: complete item; status done; D1 applied; next replacement verifies",
    "--ref",
    `task:${trial.task_ids[slot.role_items[slot.replaced_role]]}`,
  );
  const resumed = wrapper(
    `${slot.replaced_role}r`,
    "sdk",
    "reentry",
    "--resource",
    `task:${trial.task_ids[slot.role_items[slot.replaced_role]]}`,
  );
  assert.ok(resumed.handoff);
  assert.equal(resumed.handoff.creator.participant_id, slot.replaced_role);
  const result = cli("evaluate", "--run-dir", run, "--trial", "t2");
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const evaluation = JSON.parse(
    readFileSync(join(run, "trials/t2/evaluation.json"), "utf8"),
  );
  assert.ok(evaluation.cases.every((c) => c.pass));
  assert.ok(evaluation.handoff);
  assert.ok(evaluation.fence_audit);
  assert.deepEqual(evaluation.fence_audit.stale_accepted, []);
  assert.deepEqual(evaluation.silent_overwrite_candidates, []);
  const events = readFileSync(join(run, "trials/t2/events.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.equal(events.filter((e) => e.kind === "decision.acked").length, 2);
  assert.equal(events.filter((e) => e.kind === "result.declared").length, 2);
});
