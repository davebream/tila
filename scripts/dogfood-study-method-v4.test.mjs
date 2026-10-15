/** Source-only checks of the prospective method draft; never launches or scores subjects. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  ACCEPT_RUNNER_SOURCE,
  allScenarios,
  warmupScenario,
} from "./dogfood-study-fixtures.mjs";
import {
  buildDeclaration,
  canonicalJson,
  checkMatching,
  sha256Text,
} from "./dogfood-study-lib.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const paths = {
  protocol: "docs/14-DOGFOOD-STUDY-PROTOCOL-v4-draft-v1.md",
  rubric: "docs/evidence/issue-194-rubric-v4-draft-v1.json",
  inventory: "docs/evidence/issue-194-service-inventory-v4-draft-v1.json",
  comparator: "docs/evidence/issue-194-comparator-v4-draft-v1.json",
  declaration: "docs/evidence/issue-194-declaration-v4-draft-v1.json",
};
const read = (path) => readFileSync(resolve(root, path), "utf8");
const readJson = (path) => JSON.parse(read(path));
const hash = (value) => sha256Text(canonicalJson(value));
const old = readJson("docs/evidence/issue-194-rubric-v3.json");
const scenarios = allScenarios();
const warmup = warmupScenario();
const expectedOperations = [
  "board-ack",
  "board-result",
  "board-reaffirm",
  "sdk-claim",
  "sdk-renew",
  "sdk-release",
  "sdk-handoff-create",
  "sdk-handoff-list",
  "sdk-reentry",
  "sdk-journal-dump",
  "cli-task-show",
  "cli-task-list",
  "cli-task-update",
  "cli-state",
  "cli-state-list",
  "cli-artifact-get",
  "cli-artifact-cat",
  "cli-artifact-list",
  "cli-artifact-history",
  "cli-artifact-reviews",
  "cli-artifact-rel-list",
  "cli-artifact-latest",
  "cli-artifact-grep",
  "cli-artifact-search",
  "cli-journal-tail",
  "helper-acquire",
  "helper-transfer",
  "handoff-file",
  "resume-file",
  "markdown-notes",
  "git-edit-test",
];
const history = {
  "issue-194-rubric-v1.json":
    "819ae6483ccb60c1359ba55a642d73d6398adfcca4420ada626cdc13a49243d7",
  "issue-194-rubric-v2.json":
    "d0bef5d5003856ba8c2b7998df0b31adb2623f1ad6b53c30b655632f40443956",
  "issue-194-rubric-v3.json":
    "d9706a022131a5cb919c741a5e550f5f958332dc49af2f20d8a97a723702612f",
  "issue-194-manifest-v3.json":
    "267802195cf1ffd4fbe7ef588f4cd85cff1245aca494f20399b86f30afcbf975",
  "issue-194-method-erratum-v1.md":
    "0200909552c751545a6c940f86434b2e2860d69f582b14fd89f64bcb06965343",
};

function loadDraft() {
  const raw = Object.fromEntries(
    Object.entries(paths).map(([key, path]) => [key, read(path)]),
  );
  return {
    raw,
    ...Object.fromEntries(
      Object.keys(paths)
        .filter((key) => key !== "protocol")
        .map((key) => [key, JSON.parse(raw[key])]),
    ),
  };
}

function fixtureComponents() {
  return {
    scenarios: Object.fromEntries(
      [...scenarios, warmup].map((scenario) => [
        scenario.id,
        Object.fromEntries(
          [
            "repoFiles",
            "cases",
            "reference",
            "mutant",
            "decision",
            "helper",
            "items",
            "frozenPaths",
            "sharedPaths",
          ].map((key) => [key, hash(scenario[key])]),
        ),
      ]),
    ),
    original_runner_source_sha256: sha256Text(ACCEPT_RUNNER_SOURCE),
  };
}

// Test-only validation: deliberately separate from the v3 runner/decoder and freeze commands.
function validate(draft) {
  const errors = [];
  const { declaration: d, rubric: r, inventory: i, comparator: c } = draft;
  const equal = (name, actual, expected) => {
    if (canonicalJson(actual) !== canonicalJson(expected)) errors.push(name);
  };
  const require = (name, condition) => {
    if (!condition) errors.push(name);
  };
  const { declaration_sha256: declaredHash, ...body } = d;
  equal("declaration hash", declaredHash, hash(body));
  equal(
    "declaration schema",
    d.schema,
    "tila.dogfood.method-declaration/4-draft-1",
  );
  equal("declaration kind", d.kind, "prospective_method_draft");
  equal(
    "declaration fields",
    Object.keys(d).sort(),
    [
      "schema",
      "kind",
      "issue",
      "method_version",
      "draft_revision",
      "status",
      "history",
      "artifacts",
      "preserved_history",
      "fixture_source",
      "scenarios",
      "warmup",
      "allocation",
      "trials",
      "budgets",
      "timeline_ms_from_t0",
      "role_mapping",
      "subject",
      "semantic_reviewer",
      "packet_recipe_contract",
      "comparator_contract",
      "future_execution_identity_requirements",
      "validation",
      "fixture_components",
      "declaration_sha256",
      "provider_reference_source",
    ].sort(),
  );
  equal(
    "version",
    [
      d.issue,
      d.method_version,
      d.draft_revision,
      r.rubric_version,
      r.draft_revision,
    ],
    [194, 4, 1, 4, 1],
  );
  for (const [key, schema] of Object.entries({
    rubric: "rubric",
    inventory: "service-inventory",
    comparator: "comparator-contract",
  })) {
    equal(
      `${key} schema`,
      draft[key].schema,
      `tila.dogfood.${schema}/4-draft-1`,
    );
    equal(`${key} issue`, draft[key].issue, 194);
  }
  for (const key of ["protocol", "rubric", "inventory", "comparator"]) {
    equal(`${key} path`, d.artifacts[key]?.path, paths[key]);
    equal(`${key} bytes`, d.artifacts[key]?.sha256, sha256Text(draft.raw[key]));
  }
  equal("history identities", d.preserved_history, history);
  for (const [name, expectedHash] of Object.entries(history)) {
    equal(
      `preserve ${name}`,
      sha256Text(read(`docs/evidence/${name}`)),
      expectedHash,
    );
  }
  equal("fixture source", d.fixture_source, {
    path: "scripts/dogfood-study-fixtures.mjs",
    sha256: sha256Text(read("scripts/dogfood-study-fixtures.mjs")),
  });
  equal("fixture components", d.fixture_components, fixtureComponents());
  equal(
    "provider reference commit",
    d.provider_reference_source.reference_commit,
    "5a3cd6463eab41cb5bc0307f89839af280c3412b",
  );
  for (const [path, expectedHash] of Object.entries(
    d.provider_reference_source.files,
  )) {
    equal(`provider reference ${path}`, sha256Text(read(path)), expectedHash);
  }
  const regenerated = buildDeclaration({
    rubric: r,
    rubricSha256: sha256Text(draft.raw.rubric),
    rubricPath: paths.rubric,
    scenarios,
    warmup,
  });
  for (const key of [
    "scenarios",
    "warmup",
    "allocation",
    "trials",
    "budgets",
    "timeline_ms_from_t0",
  ]) {
    equal(`regenerate ${key}`, d[key], regenerated[key]);
  }
  equal("matching", checkMatching(scenarios), []);
  equal("seed", r.design.allocation.seed, "tila-194-pilot-v1");
  equal(
    "role mapping",
    r.design.role_item_mapping,
    old.design.role_item_mapping,
  );
  equal("declaration roles", d.role_mapping, r.design.role_item_mapping);
  equal(
    "trial slots",
    d.trials.map(({ trial, pair, condition, variant, replaced_role }) => ({
      trial,
      pair,
      condition,
      variant,
      replaced_role,
    })),
    [
      {
        trial: "t1",
        pair: "p1",
        condition: "A",
        variant: "x",
        replaced_role: "w2",
      },
      {
        trial: "t2",
        pair: "p1",
        condition: "B",
        variant: "y",
        replaced_role: "w1",
      },
      {
        trial: "t3",
        pair: "p2",
        condition: "B",
        variant: "x",
        replaced_role: "w2",
      },
      {
        trial: "t4",
        pair: "p2",
        condition: "A",
        variant: "y",
        replaced_role: "w1",
      },
    ],
  );
  for (const key of [
    "wall_ms_per_trial",
    "tool_calls_per_role_per_trial",
    "role_budget_includes_replacement",
    "claim_ttl_ms",
    "admitted_per_role_per_trial",
    "schedule_lateness_tolerance_ms",
  ]) {
    equal(`budget ${key}`, r.budgets[key], old.budgets[key]);
  }
  equal("timeline", r.timeline_ms_from_t0, old.timeline_ms_from_t0);
  equal("subject binding", d.subject, r.design.model);
  equal(
    "subject",
    [d.subject.exact_model_id, d.subject.effort],
    ["gpt-6.1-sol", "high"],
  );
  equal("semantic reviewer", d.semantic_reviewer, old.design.reviewer);
  equal("reviewer binding", d.semantic_reviewer, r.design.reviewer);
  equal("tools", r.budgets.count_hook.allowed_tools, ["Bash", "apply_patch"]);
  equal(
    "validity catalogue",
    r.validity_rules.map((row) => row.id),
    [
      "V4-breach",
      "V4-target",
      "V4-authority",
      "V4-identity",
      "V4-time",
      "V4-memory",
      "V4-instrument",
      "V4-operator",
      "V4-review",
      "V4-stop",
      "V4-matching",
    ],
  );
  equal("outcome taxonomy", r.outcome_taxonomy, old.outcome_taxonomy);
  equal("interventions", r.intervention_levels, old.intervention_levels);
  equal("hard gates", r.hard_gates, old.hard_gates);
  equal("metric inventory", Object.keys(r.metrics), Object.keys(old.metrics));
  equal(
    "original denominators",
    r.study_level_thresholds.original_denominators,
    { trials: 4, trials_per_arm: 2, base_roles: 8, base_roles_per_arm: 4 },
  );
  require("one-invalid rule", r.study_level_thresholds.inconclusive.includes(
    "one invalid suffices",
  ));
  equal(
    "MCP unavailability",
    r.metrics.mcp_calls.availability_rule,
    "B unavailable/null: CLI/SDK selected and MCP disabled, although explicit complete local MCP is supported. Non-exercise is not observed zero.",
  );
  equal("separate accounting facts", r.accounting.facts, [
    "admission",
    "durable_operation_outcome",
    "trusted_native_terminal",
    "explicit_role_completion",
    "trusted_task_correctness",
  ]);
  equal(
    "accounting cases",
    r.accounting.rules.map((row) => [row.case, row.slots]),
    [
      ["authentic_pre_rejection", 0],
      ["admitted_launch_or_execution_failure", 1],
      ["admitted_unavailable_resource", 1],
      ["admitted_mixed", 1],
      ["breach_or_proven_scored_target_attempt", "retain"],
      ["untrusted_required_native_evidence", "retain uncertainty"],
    ],
  );
  for (const row of r.accounting.rules.slice(1, 4))
    equal(`no refund ${row.case}`, row.refund, false);
  equal("category precedence", r.accounting.category_precedence, [
    "tila_cli",
    "tila_sdk",
    "shell_test",
    "git",
    "board_edit",
    "other",
  ]);
  equal(
    "operations",
    i.operations.map((row) => row.id).sort(),
    [...expectedOperations].sort(),
  );
  equal("participants", i.participants, ["w1", "w2", "w1r", "w2r"]);
  for (const row of i.operations) {
    equal(`${row.id} parity`, row.participants, i.participants);
    for (const key of [
      "original_recipe",
      "replacement_recipe",
      "provider",
      "arguments",
      "result_shape",
      "error_shape",
      "durable_evidence",
      "category",
    ]) {
      require(`${row.id} ${key}`, typeof row[key] === "string" &&
        row[key].length > 0);
    }
    const arms =
      row.id.startsWith("board-") || row.id.startsWith("helper-")
        ? ["A"]
        : /^(cli|sdk)-/.test(row.id)
          ? ["B"]
          : ["A", "B"];
    equal(`${row.id} arms`, row.arms, arms);
    require(`${row.id} fixed tokens`, Array.isArray(
      row.provider_operation_tokens,
    ));
  }
  equal("finite fields", i.request_contract.fields, [
    "decision_ack",
    "result_commit",
    "reaffirmed",
    "status",
  ]);
  equal("all explicit removal groups", i.intentional_removals.length, 8);
  equal(
    "packet binding",
    [d.packet_recipe_contract.path, d.packet_recipe_contract.sha256],
    [paths.protocol, sha256Text(draft.raw.protocol)],
  );
  equal(
    "comparator binding",
    [d.comparator_contract.path, d.comparator_contract.sha256],
    [paths.comparator, sha256Text(draft.raw.comparator)],
  );
  equal(
    "no fake runner",
    [c.runner_source_sha256, d.comparator_contract.runner_source_sha256],
    [null, null],
  );
  equal(
    "comparator variants",
    c.equivalence_matrix.scenarios,
    scenarios.map((s) => s.id),
  );
  equal("comparator fixtures", c.equivalence_matrix.fixtures, [
    "reference.amended",
    "reference.original",
    "repoFiles",
    "mutant.item1",
    "mutant.item2",
  ]);
  equal("comparator resource limits", c.resource_bounds, {
    per_case_wall_ms: 10000,
    per_submission_wall_ms: 120000,
    cpu_cores: 1,
    memory_bytes: 536870912,
    pids: 64,
    scratch_bytes: 67108864,
    result_bytes_per_case: 1048576,
    stdout_bytes_per_submission: 1048576,
    stderr_bytes_per_submission: 1048576,
    visible_test_wall_ms: 30000,
  });
  require("module lifecycle", c.module_lifetime.includes("cache ES modules") &&
    c.module_lifetime.includes("No restart per call"));
  equal(
    "protocol binding",
    [r.protocol_document, i.protocol_document],
    [paths.protocol, paths.protocol],
  );
  for (const [key, count, prefix] of [
    ["controls", 10, "C"],
    ["hold_gates", 8, "D"],
    ["amendments", 9, "M"],
  ]) {
    const ids = Array.from(
      { length: count },
      (_, n) => `${prefix}${n + (prefix === "D" ? 0 : 1)}`,
    );
    equal(`${key} inventory`, r.draft_contracts[key], ids);
    for (const id of ids)
      require(`protocol ${id}`, draft.raw.protocol.includes(`| ${id} `));
  }
  for (const rule of r.validity_rules)
    require(`protocol ${rule.id}`, draft.raw.protocol.includes(rule.id));
  for (const text of Object.values(draft.raw)) {
    require("no local absolute user paths", !/(?:^|[\s"'])(?:\/(?:home|Users)\/|[A-Z]:\\Users\\)/i.test(
      text,
    ));
  }
  require("no execution attestation", !Object.keys(d).some((key) =>
    ["frozen", "source_sha", "smoke_pass", "hook_smoke_attested"].includes(key),
  ));
  return errors;
}

// Rehash mutations to ensure semantic checks do more than accept self-consistent digests.
function rebind(draft) {
  for (const key of ["rubric", "inventory", "comparator"])
    draft.raw[key] = JSON.stringify(draft[key]);
  for (const key of ["protocol", "rubric", "inventory", "comparator"])
    draft.declaration.artifacts[key].sha256 = sha256Text(draft.raw[key]);
  draft.declaration.packet_recipe_contract.sha256 = sha256Text(
    draft.raw.protocol,
  );
  draft.declaration.comparator_contract.sha256 = sha256Text(
    draft.raw.comparator,
  );
  const { declaration_sha256: _ignored, ...body } = draft.declaration;
  draft.declaration.declaration_sha256 = hash(body);
}

test("v4 method declaration binds full prospective method and unchanged fixture history", () => {
  assert.deepEqual(validate(loadDraft()), []);
});

test("v4 identity validation catches stale bytes and rehashed budget/timeline drift", () => {
  const stale = loadDraft();
  stale.raw.protocol += "\nchanged\n";
  assert.ok(validate(stale).includes("protocol bytes"));
  for (const key of ["wall_ms_per_trial", "admitted_per_role_per_trial"]) {
    const draft = loadDraft();
    draft.rubric.budgets[key] += 1;
    draft.declaration.budgets = structuredClone(draft.rubric.budgets);
    rebind(draft);
    assert.ok(validate(draft).includes(`budget ${key}`));
  }
  const draft = loadDraft();
  draft.rubric.timeline_ms_from_t0.context_replacement += 1;
  draft.declaration.timeline_ms_from_t0 = structuredClone(
    draft.rubric.timeline_ms_from_t0,
  );
  rebind(draft);
  assert.ok(validate(draft).includes("timeline"));
});

test("v4 validation refuses service omissions, role asymmetry and accounting refunds even when rehashed", () => {
  const omitted = loadDraft();
  omitted.inventory.operations = omitted.inventory.operations.filter(
    (row) => row.id !== "cli-artifact-get",
  );
  rebind(omitted);
  assert.ok(validate(omitted).includes("operations"));
  const parity = loadDraft();
  parity.inventory.operations[0].participants.pop();
  rebind(parity);
  assert.ok(validate(parity).includes("board-ack parity"));
  const refund = loadDraft();
  refund.rubric.accounting.rules[3].refund = true;
  rebind(refund);
  assert.ok(validate(refund).includes("no refund admitted_mixed"));
});

test("v4 validation rejects comparator lifecycle/fixture drift and invented freeze evidence", () => {
  const changed = loadDraft();
  changed.declaration.fixture_components.scenarios["p1-x"].cases = "0".repeat(
    64,
  );
  changed.comparator.module_lifetime = "Restart for each call";
  changed.declaration.frozen = { smoke_pass: true };
  rebind(changed);
  const errors = validate(changed);
  for (const name of [
    "fixture components",
    "module lifecycle",
    "no execution attestation",
  ])
    assert.ok(errors.includes(name), name);
});

test("v4 validation refuses schema downgrade and denominator or review-rule drift", () => {
  const draft = loadDraft();
  draft.rubric.schema = "tila.dogfood.rubric/1";
  draft.rubric.study_level_thresholds.original_denominators.trials = 3;
  draft.rubric.validity_rules = draft.rubric.validity_rules.filter(
    (row) => row.id !== "V4-target",
  );
  rebind(draft);
  const errors = validate(draft);
  for (const name of [
    "rubric schema",
    "original denominators",
    "validity catalogue",
  ])
    assert.ok(errors.includes(name), name);
});

test("v4 protocol local links resolve without external access", () => {
  const protocol = read(paths.protocol);
  for (const match of protocol.matchAll(/\]\(([^)]+)\)/g)) {
    assert.ok(
      readFileSync(resolve(root, dirname(paths.protocol), match[1])).length > 0,
    );
  }
});
