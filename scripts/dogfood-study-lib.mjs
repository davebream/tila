/**
 * Recorder and validator for the #194 dogfood pilot.
 *
 * Pure derivation plus a locked JSONL appender and trial-local evidence reader. The driver
 * `dogfood-study.mjs` adds the filesystem, git and process work around them.
 *
 * Design rule: absence is never zero. A metric is `observed` only from an event
 * or artifact in the bundle; otherwise it is `unavailable` or `not_applicable`
 * with a reason, and the validator rejects a ledger that says otherwise.
 */
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
  win32,
} from "node:path";
import { fileURLToPath } from "node:url";

/** Stable JSON: object keys sorted recursively so hashes do not depend on insertion order. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export const EVENT_SCHEMA = "tila.dogfood.event/1";
export const LEDGER_SCHEMA = "tila.dogfood.ledger/1";
export const MANIFEST_SCHEMA = "tila.dogfood.manifest/1";
export const EVALUATION_SCHEMA = "tila.dogfood.evaluation/1";
export const STUDY_ID = "tila-194-dogfood-pilot-v1";

export const sha256Text = (text) =>
  createHash("sha256").update(text).digest("hex");

export const baseRole = (role) =>
  role === "w1r" ? "w1" : role === "w2r" ? "w2" : role;

/** Ordinary shell coordination recipes used in packets and exercised by preflight tests. */
export function baselineHelperCommands({ shared, role }) {
  const quote = (v) => `'${String(v).replace(/'/g, "'\\''")}'`;
  const lock = quote(`${shared}/locks/shared-helper`);
  const owner = quote(`${shared}/locks/shared-helper/owner`);
  const board = quote(`${shared}/BOARD.md`);
  const base = role.replace(/r$/, "");
  const acquire = `if mkdir ${lock}; then echo "${role} $(date +%T)" > ${owner} && echo "shared-helper: owner=${role} since=$(date +%T)" >> ${board}; elif [ "$(cut -d' ' -f1 ${owner})" = "${role}" ]; then echo 'already owned'; else cat ${owner}; exit 1; fi`;
  const transfer = `if [ ! -d ${lock} ]; then ${acquire}; elif [ "$(cut -d' ' -f1 ${owner})" = "${base}" ]; then echo "${role} $(date +%T) transfer from ${base}" > ${owner} && echo "TRANSFER shared-helper ${base} -> ${role} $(date +%T)" >> ${board}; elif [ "$(cut -d' ' -f1 ${owner})" = "${role}" ]; then echo 'already owned'; else cat ${owner}; exit 1; fi`;
  return { acquire, transfer };
}

// ---------------------------------------------------------------------------
// Allocation and declaration
// ---------------------------------------------------------------------------

/** Seeded, auditable variant allocation: which variant condition A receives per pair. */
export function allocateVariants(seed, pairs) {
  const out = {};
  for (const pair of pairs) {
    const digest = sha256Text(`${seed}|${pair}`);
    const bit = Number.parseInt(digest.slice(0, 2), 16) & 1;
    const a = bit === 0 ? "x" : "y";
    out[pair] = { A: a, B: a === "x" ? "y" : "x", digest };
  }
  return out;
}

/** Build the immutable declaration manifest from the rubric and generated scenarios. */
export function buildDeclaration({
  rubric,
  rubricSha256,
  rubricPath,
  scenarios,
  warmup,
}) {
  const seed = rubric.design.allocation.seed;
  const pairs = rubric.design.pairs.map((p) => p.pair);
  const allocation = allocateVariants(seed, pairs);
  const byId = Object.fromEntries(scenarios.map((s) => [s.id, s]));
  const trials = rubric.design.trial_order.map((slot, index) => {
    const variant = allocation[slot.pair][slot.condition];
    const scenario = byId[`${slot.pair}-${variant}`];
    if (!scenario) throw new Error(`no scenario for ${slot.pair}-${variant}`);
    const mapping = rubric.design.role_item_mapping.find(
      (m) => m.pair === slot.pair,
    );
    return {
      trial: slot.trial,
      order: index + 1,
      pair: slot.pair,
      condition: slot.condition,
      variant,
      scenario: scenario.id,
      scenario_sha256: scenario.sha256,
      replaced_role: slot.replaced_role,
      role_items: { w1: mapping.w1, w2: mapping.w2 },
    };
  });
  const body = {
    schema: MANIFEST_SCHEMA,
    kind: "declaration",
    study_id: STUDY_ID,
    issue: 194,
    rubric: {
      path: rubricPath,
      sha256: rubricSha256,
      version: rubric.rubric_version,
    },
    protocol_document: rubric.protocol_document,
    warmup: { scenario: warmup.id, sha256: warmup.sha256 },
    scenarios: Object.fromEntries(
      scenarios.map((s) => [
        s.id,
        {
          sha256: s.sha256,
          cases: s.cases.length,
          decision_cases: s.cases.filter((c) => c.tags.includes(s.decision.id))
            .length,
          files: Object.keys(s.repoFiles).sort(),
        },
      ]),
    ),
    allocation: {
      seed,
      rule: rubric.design.allocation.rule,
      pairs: Object.fromEntries(
        Object.entries(allocation).map(([pair, v]) => [
          pair,
          { A: v.A, B: v.B, digest: v.digest },
        ]),
      ),
    },
    trials,
    budgets: rubric.budgets,
    timeline_ms_from_t0: rubric.timeline_ms_from_t0,
    freeze_requires: [
      "source_sha",
      "source_tree_clean",
      "runtime_versions",
      "model_id",
      "count_source",
      "hook_smoke_attested",
      "count_hook_sha256",
      "usage_source",
      "host_label",
      ...(rubric.rubric_version >= 3
        ? [
            "count_hook_lib_sha256",
            "hook_config_template_sha256",
            "hook_smoke_sha256",
            "codex_binary_sha256",
          ]
        : []),
    ],
  };
  return { ...body, declaration_sha256: sha256Text(canonicalJson(body)) };
}

export function declarationHash(declaration) {
  const { declaration_sha256: _ignored, ...body } = declaration;
  return sha256Text(canonicalJson(body));
}

/** Compare a committed declaration with what the rubric and fixtures regenerate. */
export function checkDeclaration(
  declaration,
  { rubric, rubricSha256, rubricPath, scenarios, warmup },
) {
  const findings = [];
  const fail = (code, message) =>
    findings.push({ code, severity: "error", message });
  if (declaration.declaration_sha256 !== declarationHash(declaration)) {
    fail(
      "declaration_hash",
      "declaration_sha256 does not match the declaration contents",
    );
  }
  if (declaration.rubric?.sha256 !== rubricSha256) {
    fail(
      "rubric_hash",
      "declaration was built against a different rubric file",
    );
  }
  let expected;
  try {
    expected = buildDeclaration({
      rubric,
      rubricSha256,
      rubricPath,
      scenarios,
      warmup,
    });
  } catch (error) {
    fail("declaration_rebuild", String(error.message ?? error));
    return findings;
  }
  if (
    canonicalJson(declaration.allocation) !== canonicalJson(expected.allocation)
  ) {
    fail("allocation", "variant allocation differs from the seed derivation");
  }
  if (canonicalJson(declaration.trials) !== canonicalJson(expected.trials)) {
    fail(
      "trials",
      "trial order, variants or scenario hashes differ from the rubric and fixtures",
    );
  }
  if (
    canonicalJson(declaration.scenarios) !== canonicalJson(expected.scenarios)
  ) {
    fail(
      "scenarios",
      "scenario fixtures changed since the declaration was written",
    );
  }
  if (canonicalJson(declaration.warmup) !== canonicalJson(expected.warmup)) {
    fail("warmup", "warm-up fixture changed since the declaration");
  }
  return findings;
}

/** Pair matching rules from the rubric: equal files and case counts, similar reference size. */
export function checkMatching(scenarios, tolerance = 0.15) {
  const findings = [];
  const byPair = new Map();
  for (const s of scenarios.filter((x) => x.pair !== "warmup")) {
    byPair.set(s.pair, [...(byPair.get(s.pair) ?? []), s]);
  }
  for (const [pair, list] of byPair) {
    if (list.length !== 2) {
      findings.push({
        code: "matching",
        severity: "error",
        message: `${pair} needs exactly two variants`,
      });
      continue;
    }
    const [a, b] = list;
    const names = (s) =>
      Object.keys(s.repoFiles)
        .map((f) => f.replace(/[A-Za-z-]+\.mjs$/, "<m>.mjs"))
        .sort();
    if (canonicalJson(names(a)) !== canonicalJson(names(b))) {
      findings.push({
        code: "matching",
        severity: "error",
        message: `${pair} variants have different file layouts`,
      });
    }
    if (a.cases.length !== b.cases.length) {
      findings.push({
        code: "matching",
        severity: "error",
        message: `${pair} variants have different case counts`,
      });
    }
    const size = (s) =>
      Object.values({
        ...s.reference.amended.helper,
        ...s.reference.amended.item1,
        ...s.reference.amended.item2,
      })
        .join("\n")
        .split("\n").length;
    const [sa, sb] = [size(a), size(b)];
    if (Math.abs(sa - sb) / Math.max(sa, sb) > tolerance) {
      findings.push({
        code: "matching",
        severity: "error",
        message: `${pair} reference sizes differ by more than ${tolerance * 100}% (${sa} vs ${sb})`,
      });
    }
    const decisionCases = (s) =>
      s.cases.filter((c) => c.tags.includes(s.decision.id)).length;
    if (decisionCases(a) !== decisionCases(b)) {
      findings.push({
        code: "matching",
        severity: "error",
        message: `${pair} variants differ in decision-sensitive cases`,
      });
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

const REQUIRED_PAYLOAD = {
  "packet.delivered": ["role"],
  "worker.started": ["role", "participant", "context"],
  "worker.stopped": ["role", "reason"],
  "worker.replaced": ["role", "from_participant", "to_participant"],
  tool_call: ["role", "category", "source"],
  tila_call: ["role", "verb", "outcome"],
  "decision.issued": ["decision_id"],
  "decision.acked": ["decision_id", "role", "system"],
  "handoff.saved": ["role", "system", "ref"],
  "overlap.observed": ["overlap_id", "kind", "resource", "role", "response"],
  "overlap.resolved": ["overlap_id", "resolution"],
  "recovery.started": ["role", "participant"],
  "recovery.decision_stated": ["role", "candidate"],
  "recovery.first_action": ["role", "valid"],
  intervention: ["level", "reason", "active_minutes", "phase"],
  "usage.record": [
    "role",
    "context",
    "input_tokens",
    "output_tokens",
    "source",
  ],
  "result.declared": ["role", "kind"],
  "gate.violation": ["gate", "detail"],
  "trial.stopped": ["reason"],
  "harness.note": ["topic"],
  "checkpoint.reached": ["checkpoint"],
};

export const STOP_REASONS = [
  "complete",
  "hard_stop",
  "budget_calls",
  "abort_wrong_target",
  "abort_privacy",
  "harness_failure",
];

/** Problems with one event, as strings; an empty array means well-formed. */
export function validateEvent(event, rubric) {
  const problems = [];
  const need = (cond, message) => {
    if (!cond) problems.push(message);
  };
  need(
    event && typeof event === "object" && !Array.isArray(event),
    "event is not an object",
  );
  if (problems.length) return problems;
  need(event.schema === EVENT_SCHEMA, `schema must be ${EVENT_SCHEMA}`);
  need(typeof event.study_id === "string", "study_id missing");
  need(typeof event.trial_id === "string", "trial_id missing");
  need(
    Number.isInteger(event.seq) && event.seq >= 1,
    "seq must be a positive integer",
  );
  need(
    typeof event.ts_utc === "string" && !Number.isNaN(Date.parse(event.ts_utc)),
    "ts_utc must be an ISO timestamp",
  );
  need(Number.isFinite(event.mono_ms), "mono_ms must be a number");
  need(
    rubric.actor_roles.includes(event.actor?.role),
    `unknown actor role ${event.actor?.role}`,
  );
  need(rubric.event_kinds.includes(event.kind), `unknown kind ${event.kind}`);
  need(
    Object.hasOwn(rubric.provenance_classes, event.provenance),
    `unknown provenance ${event.provenance}`,
  );
  need(
    event.payload &&
      typeof event.payload === "object" &&
      !Array.isArray(event.payload),
    "payload missing or not an object",
  );
  const payload = event.payload ?? {};
  for (const field of REQUIRED_PAYLOAD[event.kind] ?? []) {
    need(
      payload[field] !== undefined && payload[field] !== null,
      `${event.kind}: payload.${field} missing`,
    );
  }
  if (event.kind === "tool_call" && payload.category !== undefined) {
    need(
      rubric.tool_call_categories.includes(payload.category),
      `unknown tool category ${payload.category}`,
    );
    if (rubric.rubric_version >= 3 && !payload.denied) {
      for (const key of ["session_id", "turn_id", "tool_use_id", "tool"])
        need(
          typeof payload[key] === "string" && payload[key].trim().length > 0,
          `tool_call: ${key} missing`,
        );
      need(payload.source === "hook", "tool_call: source must be frozen hook");
    }
  }
  if (event.kind === "tila_call" && payload.outcome !== undefined) {
    need(
      rubric.tila_call_outcomes.includes(payload.outcome),
      `unknown tila outcome ${payload.outcome}`,
    );
  }
  if (event.kind === "trial.stopped" && payload.reason !== undefined) {
    need(
      STOP_REASONS.includes(payload.reason),
      `unknown stop reason ${payload.reason}`,
    );
  }
  if (event.kind === "intervention" && payload.level !== undefined) {
    need(
      ["I1", "I2", "I3"].includes(payload.level),
      `unknown intervention level ${payload.level}`,
    );
  }
  if (event.kind === "gate.violation") {
    need(
      typeof payload.gate === "string",
      "gate.violation: payload.gate must be a string",
    );
    if (typeof payload.gate === "string")
      need(
        Object.hasOwn(rubric.hard_gates, payload.gate) &&
          payload.gate.startsWith("G"),
        "unknown correctness gate",
      );
  }
  if (event.kind === "usage.record") {
    need(
      payload.source === "native_usage_record",
      "usage.record source must be native_usage_record",
    );
  }
  return problems;
}

function withLock(lockDir, fn, { timeoutMs = 5000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      mkdirSync(lockDir);
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (Date.now() > deadline) throw new Error(`could not lock ${lockDir}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
}

export function monotonicMs() {
  return Number(process.hrtime.bigint() / 1_000_000n);
}

/**
 * Append events under the file lock. `decide(events)` sees every event so far and returns
 * a partial event, an array of them, or null. Both clocks are read inside the lock so
 * seq and mono_ms stay ordered across processes.
 */
export function appendEventsWith(
  file,
  rubric,
  decide,
  { now = () => new Date(), mono = monotonicMs } = {},
) {
  mkdirSync(dirname(file), { recursive: true });
  return withLock(`${file}.lock`, () => {
    const text = existsSync(file) ? readFileSync(file, "utf8") : "";
    const parsed = parseEvents(text);
    if (parsed.problems.length || (text && !text.endsWith("\n")))
      throw new Error(
        "event log is incomplete or malformed; retain it for audit",
      );
    const existing = parsed.events;
    for (const [i, event] of existing.entries()) {
      if (
        validateEvent(event, rubric).length ||
        event.seq !== i + 1 ||
        (i > 0 && event.mono_ms < existing[i - 1].mono_ms)
      )
        throw new Error("event log is inconsistent; retain it for audit");
    }
    const decided = decide(existing);
    const list =
      decided === null ? [] : Array.isArray(decided) ? decided : [decided];
    let seq = existing.length ? existing[existing.length - 1].seq : 0;
    const written = [];
    for (const partial of list) {
      seq += 1;
      const event = {
        schema: EVENT_SCHEMA,
        study_id: STUDY_ID,
        trial_id: basename(dirname(file)),
        seq,
        ts_utc: now().toISOString(),
        mono_ms: mono(),
        provenance: "local_agent_trial",
        payload: {},
        ...partial,
      };
      const problems = validateEvent(event, rubric);
      if (problems.length)
        throw new Error(`invalid event: ${problems.join("; ")}`);
      appendFileSync(file, `${JSON.stringify(event)}\n`);
      written.push(event);
    }
    return written;
  });
}

export function appendEvent(file, partial, rubric, clocks) {
  return appendEventsWith(file, rubric, () => partial, clocks)[0];
}

export function parseEvents(text) {
  const events = [];
  const problems = [];
  text
    .split("\n")
    .filter(Boolean)
    .forEach((line, i) => {
      try {
        events.push(JSON.parse(line));
      } catch {
        problems.push(`line ${i + 1} is not JSON`);
      }
    });
  return { events, problems };
}

// ---------------------------------------------------------------------------
// Redaction scan
// ---------------------------------------------------------------------------

const REDACTION_PATTERNS = [
  ["home_path", /\/home\/[A-Za-z0-9._-]+\//],
  ["home_path", /\/Users\/[A-Za-z0-9._-]+\//],
  ["email", /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/],
  ["tila_token", /\btila_[A-Za-z0-9_]{12,}/],
  ["api_key", /\bsk-[A-Za-z0-9_-]{16,}/],
  ["bearer", /Bearer\s+[A-Za-z0-9._~+/=-]{12,}/],
  ["github_token", /\bgh[pousr]_[A-Za-z0-9]{20,}/],
  ["aws_key", /\bAKIA[0-9A-Z]{16}\b/],
  ["private_key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
];

export function scanRedaction(text) {
  const hits = [];
  for (const [name, pattern] of REDACTION_PATTERNS) {
    const match = pattern.exec(text);
    if (match) hits.push({ pattern: name, sample: `${match[0].slice(0, 6)}…` });
  }
  for (const ip of text.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g) ?? []) {
    if (
      !["127.0.0.1", "0.0.0.0"].includes(ip) &&
      ip.split(".").every((n) => Number(n) <= 255)
    ) {
      hits.push({ pattern: "ip_address", sample: ip });
      break;
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Tool-call categorisation (for hook and transcript adapters supplied by the run lead)
// ---------------------------------------------------------------------------

export function categorizeToolCall(tool, { command = "", path = "" } = {}) {
  const t = String(tool).toLowerCase();
  if (["read", "view"].includes(t)) return "read";
  if (["grep", "glob", "find", "search"].includes(t)) return "search";
  if (
    ["edit", "write", "multiedit", "notebookedit", "apply_patch"].includes(t)
  ) {
    return /(?:^|\/)(BOARD\.md|DECISIONS\.md|HANDOFFS\/)/.test(path)
      ? "board_edit"
      : "edit";
  }
  if (["bash", "shell"].includes(t)) {
    if (/dogfood-study-tila\.mjs\s+tila\b/.test(command)) return "tila_cli";
    if (/dogfood-study-tila\.mjs\s+sdk\b/.test(command)) return "tila_sdk";
    if (/\bnode\s+--test\b|\b(?:npm|pnpm)\s+(?:run\s+)?test\b/.test(command))
      return "shell_test";
    if (/^\s*git\b/.test(command)) return "git";
    if (/(BOARD\.md|DECISIONS\.md|HANDOFFS\/)/.test(command))
      return "board_edit";
  }
  return "other";
}

// ---------------------------------------------------------------------------
// Journal audit (fences are audited from journal order, not from client responses)
// ---------------------------------------------------------------------------

/**
 * `items` are journal rows ({seq, kind, resource, participant_id, fence}). A fenced write is an
 * `entity.updated` row carrying a fence. Claim rows use `task:<id>`, entity rows the bare id.
 * Fences are capability numbers: a write presenting the current number is accepted from any
 * participant, so a different presenter is a holder mismatch, not a stale write.
 */
export function auditJournal(items) {
  const rows = [...items].sort((a, b) => a.seq - b.seq);
  const latest = new Map();
  const staleAccepted = [];
  const holderMismatch = [];
  let updates = 0;
  for (const row of rows) {
    if (row.kind === "claim.acquired" && Number.isFinite(row.fence)) {
      latest.set(row.resource, {
        fence: row.fence,
        participant: row.participant_id,
      });
    }
    if (row.kind === "entity.updated" && Number.isFinite(row.fence)) {
      updates += 1;
      const current =
        latest.get(`task:${row.resource}`) ?? latest.get(row.resource);
      if (!current) continue;
      if (row.fence < current.fence) staleAccepted.push(row.seq);
      else if (
        row.fence === current.fence &&
        row.participant_id !== current.participant
      ) {
        holderMismatch.push(row.seq);
      }
    }
  }
  return {
    stale_accepted: staleAccepted,
    holder_mismatch: holderMismatch,
    fenced_updates: updates,
  };
}

/**
 * Invocation-local Codex config. The lead must smoke-test its coverage/failure behavior;
 * supported deny output alone does not establish that a timeout blocks the tool.
 */
export function buildHookSettings({ hookScript, runDir, trial, role }) {
  const quote = (v) => `'${String(v).replace(/'/g, "'\\''")}'`;
  return {
    argv: [
      "--no-daemon",
      "--strict-config",
      "-m",
      "gpt-6.1-sol",
      "-c",
      'model_reasoning_effort="high"',
      "-c",
      "features.hooks=true",
      "-c",
      "agents.enabled=false",
      "-c",
      'web_search="disabled"',
      "-c",
      "features.apps=false",
      "-c",
      "features.plugins=false",
      "-c",
      "features.remote_plugin=false",
      "-c",
      "mcp_servers={}",
      ...["PreToolUse", "PostToolUse"].flatMap((event) => [
        "-c",
        `hooks.${event}=[{matcher=".*",hooks=[{type="command",command=${JSON.stringify(`node ${quote(hookScript)} budget-hook --run-dir ${quote(runDir)} --trial ${trial} --role ${role}`)},async=false,timeout=15}]}]`,
      ]),
    ],
    allowed_tools: ["Bash", "apply_patch"],
    trust:
      "lead reviews these run-owned hooks; invocation-local hook-trust bypass may be added after review, without changing normal approvals/sandbox permissions",
  };
}

/** Prevent source CLI calls from attaching to the builder's/subject's managed session. */
export function studyCliEnv(participant, machine) {
  const env = {
    ...process.env,
    TILA_PARTICIPANT_ID: participant,
    TILA_MACHINE: machine,
  };
  for (const key of [
    "CODEX_THREAD_ID",
    "TILA_LIFECYCLE_KEY",
    "TILA_RUN_SOCKET",
    "TILA_RUN_CAPABILITY",
  ])
    delete env[key];
  return env;
}

export const HOOK_CONFIG_TEMPLATE_SHA256 = sha256Text(
  canonicalJson(
    buildHookSettings({
      hookScript: "$SOURCE/scripts/dogfood-study-tila.mjs",
      runDir: "$RUN",
      trial: "$TRIAL",
      role: "$ROLE",
    }),
  ),
);

// ---------------------------------------------------------------------------
// Ledger derivation
// ---------------------------------------------------------------------------

const observed = (value, evidence = []) => ({
  availability: "observed",
  value,
  evidence,
});
const unavailable = (reason) => ({
  availability: "unavailable",
  value: null,
  reason,
});
const notApplicable = (reason) => ({
  availability: "not_applicable",
  value: null,
  reason,
});

/**
 * Resolve only regular files below the supplied trial directory. Reject lexical
 * traversal and symlinks before reading, including links that point back inside.
 */
function readOverlapRecord(trialDir, record) {
  if (!trialDir) throw new Error("trial directory unavailable");
  const ref = record?.ref;
  if (
    typeof ref !== "string" ||
    !ref.trim() ||
    isAbsolute(ref) ||
    win32.isAbsolute(ref) ||
    /[\\:\0]/.test(ref) ||
    ref.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new Error("reference must be a relative path without traversal");
  if (!/^[a-f0-9]{64}$/.test(record.sha256 ?? ""))
    throw new Error("record SHA-256 missing or malformed");
  if (lstatSync(trialDir).isSymbolicLink())
    throw new Error("trial directory is a symlink");
  const root = realpathSync(trialDir);
  const path = resolve(root, ref);
  const rel = relative(root, path);
  if (!rel || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new Error("reference escapes trial directory");
  let current = root;
  for (const part of ref.split("/")) {
    current = join(current, part);
    if (lstatSync(current).isSymbolicLink())
      throw new Error("reference contains a symlink");
  }
  if (!lstatSync(path).isFile())
    throw new Error("reference is not a regular file");
  const bytes = readFileSync(path);
  if (sha256Text(bytes) !== record.sha256)
    throw new Error("record SHA-256 mismatch");
  return JSON.parse(bytes.toString("utf8"));
}

/** Reject a malformed stream without modifying or dropping retained raw evidence. */
export function assertValidEvents(
  events,
  rubric,
  { envelopesOnly = false } = {},
) {
  if (!Array.isArray(events))
    throw new Error("invalid event stream: expected an array");
  for (const [index, event] of events.entries()) {
    const envelopeValid =
      event &&
      typeof event === "object" &&
      !Array.isArray(event) &&
      event.payload &&
      typeof event.payload === "object" &&
      !Array.isArray(event.payload) &&
      event.actor &&
      typeof event.actor === "object" &&
      typeof event.kind === "string" &&
      Number.isInteger(event.seq) &&
      Number.isFinite(event.mono_ms);
    const problems = validateEvent(event, rubric);
    if (
      problems.length &&
      (!envelopesOnly || !envelopeValid || event.kind !== "tool_call")
    )
      throw new Error(
        `invalid event at index ${index}: ${problems.join("; ")}; retain raw log for audit`,
      );
  }
}

/** Context is reopened from the same prepared trial for evaluate, derive and validate. */
export function preventionContext({ trial, events, rubric, trialDir }) {
  try {
    assertValidEvents(events, rubric);
    const config = JSON.parse(
      readFileSync(join(trialDir, "trial.json"), "utf8"),
    );
    if (
      config.trial !== trial.trial ||
      config.condition !== trial.condition ||
      !config.helper_resource ||
      !config.shared ||
      !config.run_dir ||
      !config.participants
    )
      return null;
    const started = events.filter((e) => e.kind === "trial.started");
    if (started.length > 1) return null;
    return {
      config,
      events,
      rubric,
      started: started[0] ?? null,
      deadline: started[0]
        ? started[0].mono_ms + rubric.budgets.wall_ms_per_trial
        : null,
    };
  } catch {
    return null;
  }
}

export function preventionOwner(context, at = Number.POSITIVE_INFINITY) {
  if (!context) return null;
  const { config, events } = context;
  if (config.condition === "B") {
    if (!context.started) return null;
    const resource = `task:${config.task_ids?.helper}`;
    const ownership = events.filter(
      (e) =>
        e.kind === "tila_call" &&
        e.provenance === "local_agent_trial" &&
        e.actor.role === e.payload.role &&
        e.payload.resource === resource &&
        e.payload.outcome === "ok" &&
        ["sdk claim", "sdk release"].includes(e.payload.verb) &&
        e.mono_ms >= context.started.mono_ms &&
        e.mono_ms < context.deadline &&
        e.mono_ms <= at,
    );
    const last = ownership.at(-1);
    return last?.payload.verb === "sdk claim" &&
      ["w1", "w2"].includes(baseRole(last.payload.role))
      ? baseRole(last.payload.role)
      : null;
  }
  try {
    const board = readFileSync(join(config.shared, "BOARD.md"), "utf8");
    const named = [...board.matchAll(/shared-helper:\s*owner=(w[12]r?)\b/g)].at(
      -1,
    )?.[1];
    const lock = join(config.shared, "locks/shared-helper/owner");
    const locked = existsSync(lock)
      ? /^(w[12]r?)\b/.exec(readFileSync(lock, "utf8"))?.[1]
      : null;
    if (named && locked && baseRole(named) !== baseRole(locked)) return null;
    return baseRole(locked ?? named ?? null);
  } catch {
    return null;
  }
}

function supportedPreventionCommand(command, context, role, participant) {
  const { config } = context;
  if (config.condition === "A") {
    const recipes = baselineHelperCommands({ shared: config.shared, role });
    return (
      ["bash", "sh", "/bin/bash", "/bin/sh"].includes(command[0]) &&
      command.length === 3 &&
      command[1] === "-c" &&
      [
        recipes.acquire,
        ...(role.endsWith("r") ? [recipes.transfer] : []),
      ].includes(command[2])
    );
  }
  const prefix = [
    command[0],
    join(dirname(fileURLToPath(import.meta.url)), "dogfood-study-tila.mjs"),
    "sdk",
    "--run-dir",
    config.run_dir,
    "--trial",
    config.trial,
    "--participant",
    participant,
    "claim",
    `task:${config.task_ids?.helper}`,
  ];
  return (
    ["node", process.execPath].includes(command[0]) &&
    config.task_ids?.helper &&
    prefix.every((arg, i) => command[i] === arg) &&
    (command.length === prefix.length ||
      (command.length === prefix.length + 2 &&
        command.at(-2) === "--ttl-ms" &&
        /^\d+$/.test(command.at(-1)) &&
        Number(command.at(-1)) > 0))
  );
}

/**
 * Verify retained bytes and their explicit attempt/response/edit-audit contents.
 * Unsupported native formats remain unavailable. This checks corroborating
 * records, not their capture authenticity; native coverage still needs audit.
 * No caller-supplied `verified` boolean or cached result earns credit.
 */
export function verifyPreventionEvidence(event, trialDir, context = null) {
  const p = event?.payload;
  const evidence = p?.prevention_evidence;
  const fail = (reason) => ({ verified: false, reason });
  if (
    !(
      p &&
      event.kind === "overlap.observed" &&
      event.provenance === "local_agent_trial" &&
      ["stopped", "redirected"].includes(p.response) &&
      p.edits_before_redirect === 0 &&
      evidence?.schema === "tila.dogfood.overlap-evidence/1" &&
      Number.isFinite(evidence.attempt?.mono_ms) &&
      Number.isFinite(evidence.response?.mono_ms) &&
      evidence.attempt.mono_ms <= evidence.response.mono_ms &&
      evidence.response.mono_ms <= event.mono_ms
    )
  )
    return fail("incomplete or unordered prevention claim");
  if (
    !context?.started ||
    context.started.provenance !== "local_agent_trial" ||
    validateEvent(event, context.rubric).length ||
    event.trial_id !== context.config.trial ||
    p.resource !== context.config.helper_resource ||
    !["w1", "w2", "w1r", "w2r"].includes(p.role)
  )
    return fail("prepared trial/helper context missing or mismatched");
  const owner = preventionOwner(context, evidence.attempt.mono_ms);
  if (!owner || baseRole(p.role) === owner)
    return fail("attempt role is not the known helper owner's competitor");
  const registration = context.events
    .filter(
      (e) =>
        e.kind === "worker.started" &&
        e.payload.role === p.role &&
        e.mono_ms <= evidence.attempt.mono_ms,
    )
    .at(-1);
  const participant = context.config.participants[p.role];
  const boundaries = context.events.filter(
    (e) =>
      e.kind === "trial.stopped" ||
      (["worker.stopped", "worker.replaced"].includes(e.kind) &&
        e.payload.role === p.role),
  );
  if (
    !registration ||
    !participant ||
    registration.payload.participant !== participant ||
    registration.provenance !== "local_agent_trial" ||
    registration.actor.role !== p.role ||
    registration.payload.context !==
      (p.role.endsWith("r") ? "replacement" : "original") ||
    (p.role.endsWith("r") &&
      !context.events.some(
        (e) =>
          e.kind === "worker.replaced" &&
          e.payload.role === baseRole(p.role) &&
          e.payload.to_participant === participant &&
          e.mono_ms <= registration.mono_ms &&
          e.seq < registration.seq,
      )) ||
    typeof registration.payload.session_id !== "string" ||
    !registration.payload.session_id.trim() ||
    evidence.attempt.mono_ms < context.started.mono_ms ||
    evidence.response.mono_ms >= context.deadline ||
    boundaries.some((e) => evidence.response.mono_ms >= e.mono_ms)
  )
    return fail("attempt/response outside the registered live trial context");
  let attempt;
  let response;
  let before;
  try {
    attempt = readOverlapRecord(trialDir, evidence.attempt);
    response = readOverlapRecord(trialDir, evidence.response);
    before = readOverlapRecord(trialDir, evidence.before_edit);
  } catch (error) {
    return fail(
      error instanceof SyntaxError
        ? "retained record is not valid JSON"
        : error.code
          ? `retained record unavailable (${error.code})`
          : error.message,
    );
  }
  const sameClaim = (record, kind) =>
    record?.schema === "tila.dogfood.overlap-record/1" &&
    record.kind === kind &&
    record.provenance === "local_agent_trial" &&
    record.study_id === event.study_id &&
    record.participant === participant &&
    record.session_id === registration.payload.session_id &&
    record.trial_id === event.trial_id &&
    record.overlap_id === p.overlap_id &&
    record.role === p.role &&
    record.resource === p.resource &&
    typeof record.attempt_id === "string" &&
    record.attempt_id.trim().length > 0 &&
    record.attempt_id === attempt?.attempt_id;
  if (
    !sameClaim(attempt, "attempt") ||
    !sameClaim(response, "response") ||
    !sameClaim(before, "before_edit")
  )
    return fail("retained record identities do not match the claimed attempt");
  if (
    attempt.intent !== "implement_shared_helper" ||
    !Array.isArray(attempt.command) ||
    !attempt.command.length ||
    !attempt.command.every((arg) => typeof arg === "string" && arg.trim()) ||
    attempt.mono_ms !== evidence.attempt.mono_ms
  )
    return fail("record does not establish a competing helper attempt");
  if (
    !supportedPreventionCommand(attempt.command, context, p.role, participant)
  )
    return fail(
      "unsupported command: competing helper target/trial/participant not established",
    );
  if (
    response.mono_ms !== evidence.response.mono_ms ||
    response.disposition !== p.response ||
    typeof response.stdout !== "string" ||
    typeof response.stderr !== "string"
  )
    return fail("record does not establish the claimed response");
  const stopped =
    response.disposition === "stopped" &&
    response.exit_code === 1 &&
    /already[_ -]held|already[_ -]owned|file exists/i.test(
      response.stdout + response.stderr,
    );
  // These exact lock/claim commands deny competing acquisition; neither redirects.
  if (!stopped)
    return fail("response does not corroborate the supported stopping command");
  if (
    before.from_mono_ms !== attempt.mono_ms ||
    before.through_mono_ms !== response.mono_ms ||
    !Number.isFinite(before.mono_ms) ||
    before.mono_ms < response.mono_ms ||
    before.mono_ms > event.mono_ms ||
    before.coverage !== "attempt_through_response" ||
    !Array.isArray(before.observed_edits) ||
    before.observed_edits.length !== 0 ||
    !/^[a-f0-9]{40}$/.test(before.baseline ?? "") ||
    before.head !== before.baseline ||
    before.status !== "" ||
    before.diff !== ""
  )
    return fail(
      "before-edit record does not establish zero edits through the response",
    );
  return { verified: true };
}

export const hasPreventionEvidence = (event, trialDir, context) =>
  verifyPreventionEvidence(event, trialDir, context).verified;

// The frozen slot controls which context is replaced. Registrations control identity;
// generic recovery events and semantic verdicts cannot stand in for that lifecycle.
function replacementEvidence({
  trial,
  events,
  evaluation,
  context,
  trialDir,
  timely,
  withinTrial,
  early,
}) {
  const role = trial.replaced_role;
  const replacementRole = `${role}r`;
  const problems = [];
  const need = (ok, reason) => {
    if (!ok) problems.push(reason);
  };
  const replacements = events.filter((e) => e.kind === "worker.replaced");
  const registrations = events.filter((e) => e.kind === "worker.started");
  const replacementRegistrations = registrations.filter(
    (e) =>
      e.payload.context === "replacement" ||
      (typeof e.payload.role === "string" && e.payload.role.endsWith("r")),
  );
  const recoveries = events.filter((e) => e.kind.startsWith("recovery."));
  const starts = recoveries.filter((e) => e.kind === "recovery.started");
  const handoffs = events.filter((e) => e.kind === "handoff.saved");
  const original = registrations.filter((e) => e.payload.role === role);
  const replacement = replacementRegistrations[0];
  const retired = events.filter(
    (e) => e.kind === "worker.stopped" && e.payload.reason === "replacement",
  );
  const before = (a, b) => a && b && a.seq < b.seq && a.mono_ms <= b.mono_ms;
  const participant = (r, registration) =>
    context?.config.participants[r] ??
    (trialDir ? null : registration?.payload.participant);
  const originalParticipant = participant(role, original[0]);
  const replacementParticipant = participant(replacementRole, replacement);
  const registered = (e, r, id, kind) =>
    e &&
    e.actor.role === r &&
    e.payload.role === r &&
    e.payload.participant === id &&
    typeof id === "string" &&
    id.trim() &&
    e.payload.context === kind &&
    typeof e.payload.session_id === "string" &&
    e.payload.session_id.trim() &&
    e.provenance === "local_agent_trial" &&
    withinTrial(e);
  const identity = (e, r, id, registration) =>
    e.actor.role === r &&
    e.payload.role === r &&
    e.provenance === "local_agent_trial" &&
    (!Object.hasOwn(e.payload, "participant") ||
      e.payload.participant === id) &&
    (!Object.hasOwn(e.payload, "session_id") ||
      e.payload.session_id === registration?.payload.session_id);

  // Absence before an early abort is allowed. Observed contradictory evidence is never
  // erased or excused by the stop reason, and duplicate lifecycles are ambiguous.
  const observedLifecycle =
    replacements.length ||
    replacementRegistrations.length ||
    retired.length ||
    recoveries.length;
  if (observedLifecycle) {
    need(
      replacements.length === 1 || (early && replacements.length === 0),
      "expected exactly one declared worker replacement",
    );
    need(
      original.length === 1 &&
        registered(original[0], role, originalParticipant, "original"),
      "declared original registration/identity is missing or ambiguous",
    );
    need(
      (early && replacementRegistrations.length === 0) ||
        (replacementRegistrations.length === 1 &&
          registered(
            replacement,
            replacementRole,
            replacementParticipant,
            "replacement",
          )),
      "declared replacement registration/identity is missing or ambiguous",
    );
    need(
      (early && !replacement) ||
        (originalParticipant &&
          replacementParticipant &&
          originalParticipant !== replacementParticipant),
      "replacement must have a distinct registered participant",
    );
    need(
      (early && !replacement) ||
        (replacement &&
          registrations.filter(
            (e) => e.payload.session_id === replacement.payload.session_id,
          ).length === 1),
      "replacement must have a distinct registered session",
    );
    const change = replacements[0];
    need(
      (early && !change) ||
        (change &&
          change.payload.role === role &&
          change.payload.from_participant === originalParticipant &&
          typeof change.payload.to_participant === "string" &&
          change.payload.to_participant.trim() &&
          change.payload.to_participant !== originalParticipant &&
          (replacementParticipant
            ? change.payload.to_participant === replacementParticipant
            : early && !replacement) &&
          change.provenance === "local_agent_trial" &&
          withinTrial(change)),
      "worker.replaced contradicts the frozen role or registered participants",
    );
    need(
      (early && retired.length === 0 && !change && !replacement) ||
        (retired.length === 1 &&
          retired[0].payload.role === role &&
          retired[0].actor.role === role &&
          retired[0].provenance === "local_agent_trial" &&
          withinTrial(retired[0]) &&
          before(original[0], retired[0]) &&
          (change ? before(retired[0], change) : early && !replacement) &&
          (replacement ? before(change, replacement) : early)),
      "declared original retirement and replacement registration are not ordered",
    );
  }
  for (const e of handoffs)
    need(
      identity(e, role, originalParticipant, original[0]) &&
        registered(original[0], role, originalParticipant, "original") &&
        before(original[0], e) &&
        timely(e),
      `handoff seq ${e.seq} is outside the declared original context`,
    );
  if (evaluation?.handoff)
    need(
      evaluation.handoff.role === role,
      "evaluated handoff role contradicts the frozen role",
    );
  if (observedLifecycle && !early)
    need(starts.length === 1, "expected exactly one declared recovery start");
  if (recoveries.length) {
    need(starts.length === 1, "expected exactly one declared recovery start");
    const start = starts[0];
    need(
      start &&
        identity(start, replacementRole, replacementParticipant, replacement) &&
        start.payload.participant === replacementParticipant &&
        before(replacement, start) &&
        timely(start),
      "recovery start is outside the declared registered replacement context",
    );
    for (const e of recoveries.filter((e) => e.kind !== "recovery.started"))
      need(
        identity(e, replacementRole, replacementParticipant, replacement) &&
          before(start, e),
        `recovery seq ${e.seq} is outside the declared registered replacement context`,
      );
  }
  const lifecycleBound =
    replacements.length === 1 &&
    replacementRegistrations.length === 1 &&
    retired.length === 1 &&
    problems.length === 0;
  return {
    problems,
    handoffBound:
      lifecycleBound &&
      handoffs.length > 0 &&
      evaluation?.handoff?.role === role,
    recoveryStart:
      lifecycleBound && starts[0] && timely(starts[0]) ? starts[0] : null,
  };
}

/**
 * Derive the per-trial ledger from raw events plus the evaluator's report.
 * Events, evaluation and verified retained records supply observations. Missing
 * trialDir/records never become prevention credit; nothing is inferred from silence.
 */
export function deriveLedger({
  trial,
  events,
  evaluation,
  review = null,
  frozen,
  rubric,
  trialDir = null,
}) {
  assertValidEvents(events, rubric, { envelopesOnly: true });
  const context = preventionContext({ trial, events, rubric, trialDir });
  const cond = trial.condition;
  const roles = ["w1", "w2"];
  const flags = [];
  const stopped = events.find((e) => e.kind === "trial.stopped");
  const started = events.find((e) => e.kind === "trial.started");
  const stopReason = stopped?.payload.reason ?? null;
  const wall = started && stopped ? stopped.mono_ms - started.mono_ms : null;
  const issued = events.find((e) => e.kind === "decision.issued");
  const deadline = started
    ? started.mono_ms + rubric.budgets.wall_ms_per_trial
    : null;
  const closesContext = (boundary, role) =>
    boundary.kind === "trial.stopped" ||
    (boundary.kind === "worker.stopped" && boundary.payload.role === role) ||
    (boundary.kind === "worker.replaced" && boundary.payload.role === role);
  const timely = (event) => {
    const role = event.payload.role ?? event.actor.role;
    return (
      started &&
      event.mono_ms >= started.mono_ms &&
      event.mono_ms < deadline &&
      !events.some(
        (boundary) =>
          closesContext(boundary, role) &&
          (event.mono_ms > boundary.mono_ms ||
            (event.mono_ms === boundary.mono_ms && event.seq >= boundary.seq)),
      )
    );
  };
  const replacement = replacementEvidence({
    trial,
    events,
    evaluation,
    context,
    trialDir,
    timely,
    early: ["abort_wrong_target", "abort_privacy", "harness_failure"].includes(
      stopReason,
    ),
    withinTrial: (e) =>
      started &&
      e.seq > started.seq &&
      e.mono_ms >= started.mono_ms &&
      e.mono_ms < deadline &&
      (!stopped || (e.seq < stopped.seq && e.mono_ms <= stopped.mono_ms)),
  });
  for (const problem of replacement.problems)
    flags.push(`replacement_invalid:${problem}`);
  // Keep all raw events. Late durable writes/evidence cannot certify deadline state.
  for (const event of events) {
    const stateEvidence =
      [
        "result.declared",
        "decision.acked",
        "handoff.saved",
        "recovery.decision_stated",
        "recovery.first_action",
      ].includes(event.kind) ||
      (event.kind === "tila_call" &&
        event.payload.outcome === "ok" &&
        [
          "task update",
          "sdk claim",
          "sdk renew",
          "sdk release",
          "sdk handoff-create",
        ].includes(event.payload.verb));
    if (stateEvidence && !timely(event))
      flags.push(`late_state_evidence:${event.seq}`);
  }

  // --- fixed schedule: a message later than the tolerance invalidates the schedule ---
  const tolerance = rubric.budgets.schedule_lateness_tolerance_ms;
  const scheduled = [
    [
      "decision_issued",
      issued,
      rubric.timeline_ms_from_t0.decision_change_issued,
    ],
    [
      "handoff_requested",
      events.find(
        (e) =>
          e.kind === "checkpoint.reached" &&
          e.payload.checkpoint === "handoff_requested",
      ),
      rubric.timeline_ms_from_t0.handoff_checkpoint_requested,
    ],
    [
      "replacement_started",
      events.find(
        (e) =>
          e.kind === "checkpoint.reached" &&
          e.payload.checkpoint === "replacement_started",
      ),
      rubric.timeline_ms_from_t0.context_replacement,
    ],
  ];
  const schedule = {};
  for (const [name, event, offset] of scheduled) {
    if (!started || !event) {
      schedule[name] = {
        scheduled_ms: offset,
        actual_ms: null,
        lateness_ms: null,
      };
      flags.push(`schedule_event_missing:${name}`);
      continue;
    }
    const actual = event.mono_ms - started.mono_ms;
    schedule[name] = {
      scheduled_ms: offset,
      actual_ms: actual,
      lateness_ms: actual - offset,
    };
    if (actual - offset > tolerance) flags.push(`schedule_late:${name}`);
  }

  // --- tool calls and tokens, per role (replacements merge into their role) ---
  const perRole = {};
  for (const role of roles) {
    const all = events.filter(
      (e) => e.kind === "tool_call" && baseRole(e.actor.role) === role,
    );
    const calls = all.filter((e) => !e.payload.denied);
    const byCategory = Object.fromEntries(
      rubric.tool_call_categories.map((c) => [c, 0]),
    );
    for (const c of calls) byCategory[c.payload.category] += 1;
    const retried = calls.filter((c) => c.payload.retry_of != null).length;
    const toolCalls =
      frozen.count_source === "none"
        ? unavailable("no tool-call count source was declared at freeze")
        : observed(
            {
              attempted: all.length,
              total: calls.length,
              denied: all.length - calls.length,
              retried: calls.every((c) => Object.hasOwn(c.payload, "retry_of"))
                ? retried
                : null,
              retry_linkage_reason:
                "unavailable unless native runtime supplies retry relationships",
              unit: rubric.budgets.unit ?? "native tool invocations",
              by_category: byCategory,
            },
            calls.map((c) => c.seq),
          );

    const contexts = events
      .filter(
        (e) => e.kind === "worker.started" && baseRole(e.payload.role) === role,
      )
      .map((e) => e.payload.participant);
    const usage = events.filter(
      (e) => e.kind === "usage.record" && baseRole(e.payload.role) === role,
    );
    const covered =
      contexts.length > 0 &&
      contexts.every((p) => usage.some((u) => u.payload.context === p));
    let tokens;
    if (frozen.usage_source !== "native_usage_record") {
      tokens = unavailable(
        "no native usage source was declared at freeze; subscription usage is not converted to a price",
      );
    } else if (!covered) {
      tokens = unavailable(
        "native usage records do not cover every context of this role",
      );
    } else {
      const sum = (key) =>
        usage.reduce((n, u) => n + Number(u.payload[key] ?? 0), 0);
      tokens = observed(
        {
          input: sum("input_tokens"),
          output: sum("output_tokens"),
          cache_read: sum("cache_read_tokens"),
          cache_write: sum("cache_write_tokens"),
        },
        usage.map((u) => u.seq),
      );
    }
    const results = events.filter(
      (e) =>
        e.kind === "result.declared" &&
        baseRole(e.payload.role) === role &&
        timely(e),
    );
    const initialResult = results[0] ?? null;
    const finalResult = issued
      ? (results.find((e) => e.mono_ms > issued.mono_ms) ?? null)
      : null;
    const startedAt = events.find(
      (e) => e.kind === "worker.started" && baseRole(e.payload.role) === role,
    );
    const stoppedAt = [...events]
      .reverse()
      .find(
        (e) => e.kind === "worker.stopped" && baseRole(e.payload.role) === role,
      );
    perRole[role] = {
      tool_calls: toolCalls,
      terminal_transport_calls: unavailable(
        "no complete native runtime-call record adapter; transport is outside the admitted-operation unit",
      ),
      full_runtime_calls: unavailable(
        "no complete native runtime-call records supplied",
      ),
      tokens,
      wall_ms:
        startedAt && stoppedAt
          ? observed(stoppedAt.mono_ms - startedAt.mono_ms, [
              startedAt.seq,
              stoppedAt.seq,
            ])
          : unavailable("worker start or stop event missing"),
      declared_result: finalResult !== null,
      initial_result_ms:
        initialResult && started
          ? initialResult.mono_ms - started.mono_ms
          : null,
      final_result_ms:
        finalResult && started ? finalResult.mono_ms - started.mono_ms : null,
    };
    if (
      toolCalls.availability === "observed" &&
      toolCalls.value.total > rubric.budgets.tool_calls_per_role_per_trial
    ) {
      flags.push(`budget_overrun:${role}`);
    }
  }

  // --- gates and fence audit (journal order, not client responses) ---
  const staleRejected = events.filter(
    (e) => e.kind === "tila_call" && e.payload.outcome === "stale_fence",
  );
  const audit = evaluation?.fence_audit ?? null;
  const auditComplete =
    audit &&
    Array.isArray(audit.stale_accepted) &&
    Array.isArray(audit.holder_mismatch) &&
    Number.isInteger(audit.fenced_updates) &&
    audit.fenced_updates >= 0;
  const staleAccepted = Array.isArray(audit?.stale_accepted)
    ? audit.stale_accepted
    : [];
  const holderMismatch = Array.isArray(audit?.holder_mismatch)
    ? audit.holder_mismatch
    : [];
  if (audit) {
    const okUpdates = events.filter(
      (e) =>
        e.kind === "tila_call" &&
        e.payload.verb === "task update" &&
        e.payload.outcome === "ok",
    ).length;
    // Orchestrator seeding writes are not worker updates; a surplus of journal rows means writes bypassed the wrapper.
    if (audit.fenced_updates !== okUpdates)
      flags.push("journal_update_count_mismatch");
  }

  const declared = events.filter((e) => e.kind === "result.declared");
  const inferred = declared.filter((e) => !e.payload.explicit_ref);

  const acked = events.filter((e) => e.kind === "decision.acked" && timely(e));
  const cases = evaluation?.cases ?? [];
  const decisionCases = cases.filter((c) => c.tags.includes("D1"));
  const decisionHonoredValue = decisionCases.length
    ? decisionCases.every((c) => c.pass)
    : null;
  let lostDecisions = 0;
  let decisionUndetermined = acked.length > 0 && decisionHonoredValue === null;
  if (decisionHonoredValue === false)
    lostDecisions += new Set(acked.map((e) => baseRole(e.payload.role))).size;
  const replacedRole = trial.replaced_role;
  const ackedReplaced = acked.some(
    (e) => baseRole(e.payload.role) === replacedRole,
  );
  const stated = events.find(
    (e) =>
      replacement.recoveryStart &&
      e.kind === "recovery.decision_stated" &&
      timely(e),
  );
  const resumed = Boolean(replacement.recoveryStart);
  if (
    replacement.problems.length ||
    (ackedReplaced && !replacement.handoffBound)
  )
    decisionUndetermined = true;
  if (ackedReplaced && replacement.handoffBound) {
    const verdict = review?.handoff?.facts?.decision_or_blocker;
    if (!["correct", "incorrect", "absent"].includes(verdict))
      decisionUndetermined = true;
    else if (verdict !== "correct") lostDecisions += 1;
  }
  if (ackedReplaced && resumed) {
    if (!stated) lostDecisions += 1;
    else if (
      typeof review?.resume?.decision_correct !== "boolean" ||
      (rubric.rubric_version >= 3 &&
        (!stated.payload.text_sha256 ||
          review.resume?.text_sha256 !== evaluation?.resume?.text_sha256))
    )
      decisionUndetermined = true;
    else if (review.resume?.decision_correct !== true) lostDecisions += 1;
  }

  const silentComplete = Array.isArray(evaluation?.silent_overwrite_candidates);
  const silent =
    (silentComplete ? evaluation.silent_overwrite_candidates : [])?.filter(
      (c) => c.confirmed !== false,
    ) ?? [];
  const gates = {
    G1_stale_authority_write: gate(
      "stale_authority_accepted",
      auditComplete ? staleAccepted.length : staleAccepted.length || null,
      cond,
      !auditComplete || flags.includes("journal_update_count_mismatch"),
    ),
    G2_lost_acknowledged_decision: gate(
      "acknowledged_decision_lost",
      decisionUndetermined && !lostDecisions ? null : lostDecisions,
      cond,
      decisionUndetermined,
    ),
    G3_silent_overwrite: gate(
      "silent_overwrites",
      silentComplete ? silent.length : null,
      cond,
      !silentComplete,
    ),
    G4_inferred_completion: gate(
      "completions_inferred",
      started && stopped
        ? inferred.length +
            (stopReason === "complete"
              ? roles.filter(
                  (role) =>
                    !declared.some(
                      (e) => baseRole(e.payload.role) === role && timely(e),
                    ),
                ).length
              : 0)
        : null,
      cond,
      !started || !stopped,
    ),
  };

  for (const event of events.filter((e) => e.kind === "gate.violation")) {
    const g = gates[event.payload.gate];
    g.value = Math.max(g.value ?? 0, 1);
    g.violated = cond === "B";
    g.explicit_evidence = [...(g.explicit_evidence ?? []), event.seq];
  }

  // --- interventions ---
  const interventions = events.filter((e) => e.kind === "intervention");
  const counts = { I1: 0, I2: 0, I3: 0 };
  let minutes = 0;
  for (const i of interventions) {
    counts[i.payload.level] += 1;
    minutes += Number(i.payload.active_minutes);
  }
  const attested = events.some(
    (e) =>
      e.kind === "harness.note" && e.payload.topic === "interventions_attested",
  );
  const classification = counts.I3
    ? "invalid_as_agent_outcome"
    : counts.I1 + counts.I2
      ? "assisted"
      : "unassisted";

  // --- overlap ---
  const overlaps = events.filter((e) => e.kind === "overlap.observed");
  const overlapIds = [...new Set(overlaps.map((o) => o.payload.overlap_id))];
  const duplicateEdits = overlaps.filter(
    (o) =>
      o.payload.response === "duplicate_started" ||
      Number(o.payload.edits_before_redirect ?? 0) > 0,
  );
  const duplicateIds = new Set(duplicateEdits.map((o) => o.payload.overlap_id));
  const verified = new Set();
  for (const event of overlaps.filter((o) => o.payload.prevention_evidence)) {
    const result = verifyPreventionEvidence(event, trialDir, context);
    if (result.verified) verified.add(event);
    else
      flags.push(`prevention_evidence_invalid:${event.seq}:${result.reason}`);
  }
  const prevented = overlaps.filter(
    (o) => verified.has(o) && !duplicateIds.has(o.payload.overlap_id),
  );
  const preventedIds = new Set(prevented.map((o) => o.payload.overlap_id));
  const preventionComplete = overlapIds.every(
    (id) => preventedIds.has(id) || duplicateIds.has(id),
  );
  const recon = overlapIds
    .map((id) => {
      const o = overlaps.find((x) => x.payload.overlap_id === id);
      const r = events.find(
        (x) => x.kind === "overlap.resolved" && x.payload.overlap_id === id,
      );
      return o && r ? r.mono_ms - o.mono_ms : null;
    })
    .filter((v) => v !== null);

  // --- recovery ---
  const recStart = replacement.recoveryStart;
  const recDecision = events.find(
    (e) =>
      recStart &&
      e.kind === "recovery.decision_stated" &&
      timely(e) &&
      e.payload.candidate === true &&
      (rubric.rubric_version < 3 ||
        (e.payload.text_sha256 &&
          e.payload.text_sha256 === review?.resume?.text_sha256 &&
          e.payload.text_sha256 === evaluation?.resume?.text_sha256)),
  );
  const recAction = events.find(
    (e) =>
      recStart &&
      e.kind === "recovery.first_action" &&
      e.payload.valid === true &&
      timely(e),
  );
  const censoredAt = recStart
    ? Math.min(
        deadline,
        ...events
          .filter((e) => closesContext(e, recStart.payload.role))
          .map((e) => e.mono_ms),
      )
    : null;
  const noteCount = (topic) =>
    events.filter((e) => e.kind === "harness.note" && e.payload.topic === topic)
      .length;
  const recovery = recStart
    ? {
        to_decision: !review
          ? unavailable(
              "semantic review not recorded; the candidate time is in the event log",
            )
          : !recDecision
            ? timeOrCensor(null, recStart, censoredAt)
            : review.resume?.decision_correct === true
              ? timeOrCensor(recDecision, recStart, censoredAt)
              : timeOrCensor(null, recStart, censoredAt),
        to_action: timeOrCensor(recAction, recStart, censoredAt),
        wrong: observed(noteCount("recovery_wrong_decision")),
        repeated: observed(noteCount("recovery_repeated_work")),
        assists: observed(noteCount("recovery_operator_assist")),
      }
    : null;

  // --- metric table ---
  const evalReason = "evaluation.json missing for this trial";
  const fromEval = (fn) =>
    evaluation ? fn(evaluation) : unavailable(evalReason);
  const roleItem = (role) => trial.role_items[role];
  const noTree = evaluation?.integration?.conflict === true;
  const roleSuccess = (role) =>
    noTree
      ? unavailable("integration conflict: there is no integrated tree to test")
      : fromEval(() => {
          const subset = cases.filter((c) => c.tags.includes(roleItem(role)));
          return observed(subset.length > 0 && subset.every((c) => c.pass));
        });
  const metrics = {
    role_task_success: { w1: roleSuccess("w1"), w2: roleSuccess("w2") },
    decision_honored:
      decisionHonoredValue === null
        ? unavailable(
            noTree
              ? "integration conflict: there is no integrated tree to test"
              : evaluation
                ? "no decision-tagged cases ran"
                : evalReason,
          )
        : observed(decisionHonoredValue),
    integration_clean: fromEval((e) =>
      observed(e.integration?.conflict === false),
    ),
    conflict_opportunities: overlapIds.length
      ? observed(
          overlapIds.length,
          overlaps.map((o) => o.seq),
        )
      : unavailable(
          "no overlap.observed event: the injected opportunity was not logged",
        ),
    conflict_prevented:
      overlapIds.length && preventionComplete
        ? observed(
            preventedIds.size,
            [...prevented, ...duplicateEdits].map((o) => o.seq),
          )
        : unavailable(
            "prevention requires retained competing attempt, stopped/redirected response and before-edit evidence for every opportunity",
          ),
    duplicate_helper_definitions: fromEval((e) =>
      e.helper_definitions
        ? observed(Math.max(0, e.helper_definitions.count - 1))
        : unavailable("helper definitions not scanned"),
    ),
    duplicate_edit_events: overlapIds.length
      ? observed(duplicateEdits.length)
      : unavailable("no overlap.observed event"),
    reconciliation_ms: !overlapIds.length
      ? unavailable("no overlap.observed event")
      : recon.length
        ? observed(Math.max(...recon))
        : duplicateEdits.length
          ? unavailable("duplicate work occurred but no overlap.resolved event")
          : notApplicable("no overlap required reconciliation"),
    stale_fence_attempts:
      cond === "A"
        ? notApplicable("condition A has no fence API")
        : audit
          ? observed(
              staleRejected.length + staleAccepted.length,
              staleRejected.map((e) => e.seq),
            )
          : unavailable("journal audit not run"),
    stale_fence_rejected:
      cond === "A"
        ? notApplicable("condition A has no fence API")
        : audit
          ? observed(
              staleRejected.length,
              staleRejected.map((e) => e.seq),
            )
          : unavailable("journal audit not run"),
    stale_authority_accepted:
      cond === "A"
        ? notApplicable("condition A has no fence API")
        : audit
          ? observed(staleAccepted.length, [])
          : unavailable("journal audit not run"),
    holder_mismatch_current_fence_accepted:
      cond === "A"
        ? notApplicable("condition A has no fence API")
        : audit
          ? observed(holderMismatch.length, [])
          : unavailable("journal audit not run"),
    obsolete_work_accepted: fromEval((e) =>
      observed(e.obsolete_work_roles?.length ?? 0),
    ),
    handoff_score: !replacement.handoffBound
      ? unavailable(
          "handoff is not bound to the declared registered replacement lifecycle",
        )
      : !review
        ? unavailable(
            "semantic review not recorded; lexical candidates are not scores",
          )
        : observed(
            Object.values(review.handoff?.facts ?? {}).filter(
              (v) => v === "correct",
            ).length,
            [],
          ),
    handoff_candidate_count: !replacement.handoffBound
      ? unavailable(
          "handoff is not bound to the declared registered replacement lifecycle",
        )
      : fromEval((e) =>
          e.handoff ? observed(e.handoff.candidate_count, []) : observed(0, []),
        ),
    time_to_initial_result_ms: {
      w1:
        perRole.w1.initial_result_ms === null
          ? unavailable("no result declared")
          : observed(perRole.w1.initial_result_ms),
      w2:
        perRole.w2.initial_result_ms === null
          ? unavailable("no result declared")
          : observed(perRole.w2.initial_result_ms),
    },
    time_to_final_result_ms: {
      w1:
        perRole.w1.final_result_ms === null
          ? unavailable("no result declared or reaffirmed after D1")
          : observed(perRole.w1.final_result_ms),
      w2:
        perRole.w2.final_result_ms === null
          ? unavailable("no result declared or reaffirmed after D1")
          : observed(perRole.w2.final_result_ms),
    },
    recovery_to_decision_ms: recovery
      ? recovery.to_decision
      : unavailable("no recovery.started event"),
    recovery_to_first_action_ms: recovery
      ? recovery.to_action
      : unavailable("no recovery.started event"),
    recovery_wrong_decisions: recovery
      ? recovery.wrong
      : unavailable("no recovery.started event"),
    mcp_calls:
      cond === "A"
        ? notApplicable("condition A has no tila tools")
        : unavailable(
            "this pilot selects CLI/SDK and disables MCP; the actual MCP path was not exercised",
          ),
    operator_effort: attested
      ? observed({
          active_minutes: minutes,
          interventions: counts,
          classification,
        })
      : unavailable(
          "operator did not attest that interventions were fully recorded",
        ),
    wall_ms:
      wall === null
        ? unavailable("trial start or stop event missing")
        : observed(wall),
  };

  // The 40-call and wall bounds count as enforced only when the run-owned hook was the count
  // source, a smoke session confirmed it was honoured, and it never failed. Otherwise the trial
  // is invalid for budget compliance; it is never reported as enforced.
  const enforcementReasons = [];
  if (frozen.count_source !== "hook")
    enforcementReasons.push("count source is not the run-owned hook");
  if (frozen.count_source === "hook" && !frozen.count_hook_sha256)
    enforcementReasons.push("the exact count hook was not frozen by hash");
  if (frozen.hook_smoke_attested !== true)
    enforcementReasons.push("hook was not smoke-tested in the installed CLI");
  if (
    events.some(
      (e) => e.kind === "harness.note" && e.payload.topic === "hook_failure",
    )
  )
    enforcementReasons.push("the hook reported a failure during the trial");
  if (rubric.rubric_version >= 3) {
    for (const key of [
      "count_hook_lib_sha256",
      "hook_config_template_sha256",
      "hook_smoke_sha256",
      "codex_binary_sha256",
    ])
      if (!/^[0-9a-f]{64}$/.test(frozen[key] ?? ""))
        enforcementReasons.push(`missing frozen ${key}`);
    const sessions = events
      .filter((e) => e.kind === "worker.started")
      .map((e) => e.payload.session_id);
    const coverage = events.find(
      (e) =>
        e.kind === "harness.note" &&
        e.payload.topic === "runtime_coverage_attested" &&
        stopped &&
        e.seq > stopped.seq &&
        e.payload.source === "native_runtime_records" &&
        e.payload.complete === true &&
        e.payload.uncovered_state_changes === 0 &&
        e.payload.hook_failures === 0 &&
        /^[0-9a-f]{64}$/.test(e.payload.evidence_sha256 ?? "") &&
        Array.isArray(e.payload.session_ids) &&
        sessions.length > 0 &&
        sessions.every((id) => e.payload.session_ids.includes(id)),
    );
    if (!coverage)
      enforcementReasons.push(
        "complete runtime coverage was not attested from retained per-session records",
      );
    const seen = new Set();
    for (const e of events.filter(
      (e) => e.kind === "tool_call" && !e.payload.denied,
    )) {
      const p = e.payload;
      const registration = events.find(
        (r) =>
          r.kind === "worker.started" &&
          r.seq < e.seq &&
          r.payload.session_id === p.session_id &&
          r.payload.role === e.actor.role,
      );
      const key = `${p.session_id}|${p.tool_use_id}`;
      if (
        validateEvent(e, rubric).length ||
        p.role !== e.actor.role ||
        !registration ||
        seen.has(key) ||
        !["Bash", "apply_patch"].includes(p.tool) ||
        events.some(
          (r) =>
            r.seq < e.seq &&
            (r.kind === "trial.stopped" ||
              (r.kind === "worker.stopped" && r.payload.role === e.actor.role)),
        ) ||
        !started ||
        e.mono_ms - started.mono_ms >= rubric.budgets.wall_ms_per_trial
      )
        enforcementReasons.push(`invalid admitted invocation at seq ${e.seq}`);
      seen.add(key);
    }
  }
  const enforcement = {
    enforced: enforcementReasons.length === 0,
    source: frozen.count_source ?? "none",
    reasons: enforcementReasons,
    scope: rubric.budgets.unit ?? "native tool invocations",
  };
  if (!enforcement.enforced) flags.push("budget_not_enforced");

  const outcome = classifyOutcome({
    stopReason,
    evaluation,
    perRole,
    roles,
    trial,
    flags,
  });
  const success = outcome === "success";
  metrics.trial_success = fromEval(() => observed(success));
  if (classification === "invalid_as_agent_outcome")
    flags.push("invalid_as_agent_outcome");
  if (stopReason === null) flags.push("trial_not_stopped");

  return {
    schema: LEDGER_SCHEMA,
    study_id: STUDY_ID,
    trial: trial.trial,
    pair: trial.pair,
    condition: cond,
    variant: trial.variant,
    order: trial.order,
    outcome,
    stop_reason: stopReason,
    classification,
    schedule,
    enforcement,
    roles: perRole,
    metrics,
    gates,
    flags,
  };
}

function gate(counter, value, condition, undetermined = false) {
  return {
    counter,
    value,
    threshold: 0,
    kind: condition === "B" ? "gate" : "baseline_observation",
    violated: condition === "B" && value > 0,
    undetermined,
  };
}

function timeOrCensor(event, start, censoredAt) {
  if (event)
    return {
      ...observed(event.mono_ms - start.mono_ms, [event.seq]),
      censored: false,
    };
  if (censoredAt === null)
    return unavailable(
      "recovery never completed and the trial stop time is missing",
    );
  return {
    ...observed(censoredAt - start.mono_ms, [start.seq]),
    censored: true,
  };
}

export function classifyOutcome({
  stopReason,
  evaluation,
  perRole,
  roles,
  trial,
  flags,
}) {
  if (stopReason === "abort_wrong_target" || stopReason === "abort_privacy") {
    return "aborted_wrong_target_or_privacy";
  }
  if (stopReason === "harness_failure") return "harness_invalid";
  if (flags.includes("budget_not_enforced")) return "harness_invalid";
  if (flags.some((f) => f.startsWith("late_state_evidence:")))
    return "harness_invalid";
  if (flags.some((f) => f.startsWith("replacement_invalid:")))
    return "harness_invalid";
  if (flags.some((f) => f.startsWith("schedule_late")))
    return "harness_invalid";
  if (!evaluation) return "harness_invalid";
  if (evaluation.integration?.conflict) return "integration_conflict";
  if (evaluation.forbidden_paths?.length || evaluation.tampering?.length)
    return "failed";
  const cases = evaluation.cases ?? [];
  const allPass = cases.length > 0 && cases.every((c) => c.pass);
  const allDeclared = roles.every((r) => perRole[r].declared_result);
  const overBudget = flags.some((f) => f.startsWith("budget_overrun"));
  if (allPass && allDeclared && !overBudget) return "success";
  if (stopReason === "budget_calls" || overBudget) return "timeout_calls";
  if (!allDeclared && stopReason === "hard_stop") return "timeout_wall";
  const anyRole = roles.some((r) => {
    const subset = cases.filter((c) => c.tags.includes(trial.role_items[r]));
    return subset.length > 0 && subset.every((c) => c.pass);
  });
  return anyRole ? "partial" : "failed";
}

// ---------------------------------------------------------------------------
// Bundle validation
// ---------------------------------------------------------------------------

/**
 * Validate an evidence bundle held in memory:
 * { frozen, trials: { <id>: { events, evaluation, ledger, parseProblems } },
 *   texts: { <name>: string }, drills }
 */
export function validateBundle({ bundle, rubric, rubricSha256, declaration }) {
  const findings = [];
  const add = (code, message, trial, severity = "error") =>
    findings.push({ code, severity, trial: trial ?? null, message });
  const frozen = bundle.frozen;

  // manifest and freeze
  if (!frozen) {
    add("manifest_missing", "manifest.frozen.json is missing");
    return summarize(findings, {});
  }
  if (frozen.kind !== "frozen")
    add("manifest_kind", "manifest.frozen.json is not a frozen manifest");
  if (frozen.rubric?.sha256 !== rubricSha256)
    add("rubric_hash", "frozen manifest records a different rubric hash");
  if (frozen.declaration_sha256 !== declaration.declaration_sha256) {
    add(
      "declaration_hash",
      "frozen manifest records a different declaration hash",
    );
  }
  for (const field of declaration.freeze_requires) {
    const value = frozen.frozen?.[field];
    if (value === undefined || value === null || value === "") {
      add("incomplete_freeze", `frozen.${field} is missing`);
    }
  }
  if (frozen.frozen?.source_tree_clean === false)
    add("dirty_source", "the source tree was dirty at freeze");
  if (frozen.frozen?.provenance === "harness_fixture")
    add(
      "harness_freeze",
      "synthetic/source-root fixture freezes cannot supply scored evidence",
    );
  if (frozen.frozen && !frozen.frozen.model_id)
    add("model_unrecorded", "exact model id not recorded");
  const alloc = allocateVariants(
    declaration.allocation.seed,
    Object.keys(declaration.allocation.pairs),
  );
  for (const [pair, v] of Object.entries(alloc)) {
    if (declaration.allocation.pairs[pair]?.A !== v.A)
      add("allocation", `allocation for ${pair} does not follow the seed`);
  }

  // trial set
  const declared = declaration.trials.map((t) => t.trial);
  const present = Object.keys(bundle.trials);
  for (const id of declared) {
    if (!present.includes(id))
      add(
        "trial_missing",
        `declared trial ${id} has no evidence directory`,
        id,
      );
  }
  for (const id of present) {
    const raw = bundle.trials[id].events ?? [];
    if (
      Array.isArray(raw) &&
      raw.some((e) => e?.payload?.rule_id === "V-memory")
    )
      add(
        "memory_contaminated",
        "cross-trial memory contamination precludes comparative statements",
        id,
      );
    if (!declared.includes(id)) {
      for (const p of bundle.trials[id].parseProblems ?? [])
        add("event_parse", p, id);
      if (!Array.isArray(raw))
        add("event_schema", "event stream is not an array", id);
      for (const e of Array.isArray(raw) ? raw : [])
        for (const p of validateEvent(e, rubric)) add("event_schema", p, id);
      const replacement = (Array.isArray(raw) ? raw : []).some(
        (e) => e?.kind === "harness.note" && e.payload?.replacement_of,
      );
      if (!replacement && !id.startsWith("w-"))
        add(
          "trial_unplanned",
          `trial ${id} is not declared and is not marked replacement_of`,
          id,
        );
    }
  }

  const ledgers = {};
  const readings = [];
  for (const id of declared.filter((d) => present.includes(d))) {
    const slot = declaration.trials.find((t) => t.trial === id);
    const t = bundle.trials[id];
    const events = t.events ?? [];
    for (const p of t.parseProblems ?? []) add("event_parse", p, id);
    if (!Array.isArray(events)) {
      add("event_schema", "event stream is not an array", id);
      continue;
    }

    // Invalid raw envelopes remain retained; never derive a scored ledger from them.
    let invalid = false;
    for (const [index, e] of events.entries()) {
      for (const p of validateEvent(e, rubric)) {
        add("event_schema", `index ${index}: ${p}`, id);
        invalid = true;
      }
    }
    if (invalid || t.parseProblems?.length) continue;
    // event integrity
    let lastSeq = 0;
    let lastMono = Number.NEGATIVE_INFINITY;
    for (const e of events) {
      if (e.trial_id !== id)
        add(
          "event_trial",
          `seq ${e.seq}: trial_id ${e.trial_id} does not match directory`,
          id,
        );
      if (e.seq !== lastSeq + 1)
        add("event_seq", `seq ${e.seq} follows ${lastSeq}`, id);
      if (e.mono_ms < lastMono)
        add("event_clock", `seq ${e.seq}: mono_ms goes backwards`, id);
      lastSeq = e.seq;
      lastMono = e.mono_ms;
      if (e.study_id !== STUDY_ID)
        add("event_study", `seq ${e.seq}: wrong study_id`, id);
    }
    const starts = events.filter((e) => e.kind === "trial.started");
    const stops = events.filter((e) => e.kind === "trial.stopped");
    if (starts.length !== 1)
      add(
        "trial_start",
        `expected exactly one trial.started, found ${starts.length}`,
        id,
      );
    if (stops.length !== 1)
      add(
        "trial_stop",
        `expected exactly one trial.stopped, found ${stops.length}`,
        id,
      );

    // provenance: only local_agent_trial events may carry agent metrics
    for (const e of events) {
      if (
        e.provenance !== "local_agent_trial" &&
        !["harness.note", "gate.violation"].includes(e.kind)
      ) {
        add(
          "provenance",
          `seq ${e.seq}: ${e.kind} has provenance ${e.provenance}; agent metrics require local_agent_trial`,
          id,
        );
      }
      if (
        e.provenance === "linked_external" &&
        !(e.payload.source_ref && e.payload.candidate_sha)
      ) {
        add(
          "linked_unreferenced",
          `seq ${e.seq}: linked_external needs source_ref and candidate_sha`,
          id,
        );
      }
    }

    // replacement and overlap are required unless the trial was aborted early
    const stopReason = stops[0]?.payload.reason;
    const early = [
      "abort_wrong_target",
      "abort_privacy",
      "harness_failure",
    ].includes(stopReason);
    if (!early) {
      if (!events.some((e) => e.kind === "worker.replaced"))
        add(
          "replacement_missing",
          "scheduled context replacement was not recorded",
          id,
        );
      if (!events.some((e) => e.kind === "overlap.observed"))
        add(
          "overlap_not_recorded",
          "the injected overlap opportunity was not recorded",
          id,
        );
      if (!events.some((e) => e.kind === "decision.issued"))
        add("decision_missing", "decision change was not recorded", id);
      if (!events.some((e) => e.kind === "handoff.saved"))
        add("handoff_missing", "handoff.saved was not recorded", id);
    }
    if (stopReason === "harness_failure") {
      const rule = events.find(
        (e) => e.kind === "harness.note" && e.payload.rule_id,
      )?.payload.rule_id;
      if (!rubric.validity_rules.some((r) => r.id === rule)) {
        add(
          "invalid_without_rule",
          "harness_invalid needs a predeclared validity rule id",
          id,
        );
      }
    }
    // start skew
    const deliveries = events.filter((e) => e.kind === "packet.delivered");
    if (deliveries.length >= 2) {
      const times = deliveries.map((d) => Date.parse(d.ts_utc));
      if (Math.max(...times) - Math.min(...times) > 30000) {
        const rule = events.some(
          (e) =>
            e.kind === "harness.note" && e.payload.rule_id === "V-start-skew",
        );
        if (!rule)
          add(
            "start_skew",
            "workers started more than 30 s apart without V-start-skew",
            id,
          );
      }
    }
    // completion must be explicit
    if (stopReason === "complete") {
      for (const role of ["w1", "w2"]) {
        if (
          !events.some(
            (e) =>
              e.kind === "result.declared" && baseRole(e.payload.role) === role,
          )
        ) {
          add(
            "completion_inferred",
            `trial stopped complete but ${role} never declared a result`,
            id,
          );
        }
      }
    }
    // interventions
    for (const e of events.filter((x) => x.kind === "intervention")) {
      if (!String(e.payload.reason ?? "").trim())
        add(
          "intervention_reason",
          `seq ${e.seq}: intervention without a reason`,
          id,
        );
    }
    // redaction
    const text = JSON.stringify(events) + JSON.stringify(t.evaluation ?? {});
    for (const hit of scanRedaction(text))
      add("redaction", `possible ${hit.pattern} (${hit.sample})`, id);

    // ledger recomputation
    if (!t.evaluation && !early)
      add("evaluation_missing", "evaluation.json is missing", id);
    const trialLedger = deriveLedger({
      trial: slot,
      events,
      evaluation: t.evaluation ?? null,
      review: t.review ?? null,
      frozen: frozen.frozen ?? { count_source: "none", usage_source: "none" },
      rubric,
      trialDir: t.trialDir,
    });
    ledgers[id] = trialLedger;
    for (const flag of trialLedger.flags.filter((f) =>
      f.startsWith("replacement_invalid:"),
    ))
      add("replacement_invalid", flag, id);
    for (const flag of trialLedger.flags.filter((f) =>
      f.startsWith("prevention_evidence_invalid:"),
    ))
      add("prevention_evidence_invalid", flag, id);
    for (const flag of trialLedger.flags.filter((f) =>
      f.startsWith("late_state_evidence:"),
    ))
      add(
        "late_state_evidence",
        `${flag}: retained evidence exceeds the trial/wall/context boundary; scored state integrity is unverified`,
        id,
      );
    if (!early) {
      for (const f of trialLedger.flags.filter((x) =>
        x.startsWith("schedule_event_missing"),
      )) {
        add("schedule_event_missing", f, id);
      }
      for (const f of trialLedger.flags.filter((x) =>
        x.startsWith("schedule_late"),
      )) {
        add(
          "schedule_late",
          `${f}: later than ${rubric.budgets.schedule_lateness_tolerance_ms} ms; the trial is invalid under V-schedule`,
          id,
          "warn",
        );
      }
      if (!t.review) {
        add(
          "review_missing",
          "no semantic review: handoff score and recovery decision time are unavailable (V-review)",
          id,
          "warn",
        );
      }
    }
    if (!t.ledger) {
      add("ledger_missing", "ledger.json is missing", id);
    } else if (canonicalJson(t.ledger) !== canonicalJson(trialLedger)) {
      add(
        "ledger_mismatch",
        "stored ledger differs from the ledger recomputed from events",
        id,
      );
    }
    // metric availability discipline
    for (const [key, metric] of Object.entries(trialLedger.metrics)) {
      for (const m of metric.availability
        ? [[key, metric]]
        : Object.entries(metric).map(([k, v]) => [`${key}.${k}`, v])) {
        const [name, value] = m;
        if (
          !["observed", "estimated", "unavailable", "not_applicable"].includes(
            value.availability,
          )
        ) {
          add("availability", `${name}: unknown availability`, id);
        } else if (
          ["unavailable", "not_applicable"].includes(value.availability) &&
          (value.value !== null || !value.reason)
        ) {
          add(
            "availability",
            `${name}: ${value.availability} needs a null value and a reason`,
            id,
          );
        } else if (value.availability === "observed" && value.value === null) {
          add("availability", `${name}: observed needs a value`, id);
        }
      }
    }
    // budgets
    for (const f of trialLedger.flags.filter((x) =>
      x.startsWith("budget_overrun"),
    )) {
      add(
        "budget_overrun",
        `${f}: tool calls exceed the predeclared bound`,
        id,
      );
    }
    if (!early && !trialLedger.enforcement.enforced) {
      add(
        "budget_not_enforced",
        `budgets not enforced (${trialLedger.enforcement.reasons.join("; ")}); the trial is invalid for budget compliance`,
        id,
        "warn",
      );
    }
    const wall = trialLedger.metrics.wall_ms;
    if (
      wall.availability === "observed" &&
      wall.value > declaration.budgets.wall_ms_per_trial + 5000
    ) {
      add("wall_overrun", `trial wall ${wall.value} ms exceeds the bound`, id);
    }
    // gates
    for (const [name, g] of Object.entries(trialLedger.gates)) {
      if (g.undetermined)
        add(
          "gate_undetermined",
          `${name} lacks complete applicable correctness evidence`,
          id,
          g.kind === "gate" ? "error" : "warn",
        );
      if (g.violated)
        add(
          "gate_violation",
          `${name}: ${g.counter} = ${g.value} (threshold 0) in condition B`,
          id,
        );
    }
    if (trialLedger.flags.includes("invalid_as_agent_outcome")) {
      add(
        "intervention_I3",
        "an I3 intervention makes this trial invalid as an agent outcome",
        id,
        "warn",
      );
    }
    readings.push({
      trial: id,
      outcome: trialLedger.outcome,
      classification: trialLedger.classification,
    });
  }

  // drills never stand in for agent outcomes
  if (bundle.drills && bundle.drills.provenance !== "harness_fixture") {
    add(
      "drill_provenance",
      "preflight drills must carry provenance harness_fixture",
    );
  }
  return summarize(findings, ledgers, readings, declaration);
}

function summarize(findings, ledgers, readings = [], declaration = null) {
  const errors = findings.filter((f) => f.severity === "error");
  const gateFailures = findings.filter((f) => f.code === "gate_violation");
  let reading = "inconclusive";
  if (declaration && readings.length === declaration.trials.length) {
    const allValid = readings.every(
      (r) =>
        !["harness_invalid", "aborted_wrong_target_or_privacy"].includes(
          r.outcome,
        ) && ["unassisted", "assisted"].includes(r.classification),
    );
    const assisted = readings.filter(
      (r) => r.classification === "assisted",
    ).length;
    reading =
      allValid && assisted <= 1 && !errors.length
        ? "informative"
        : "inconclusive";
  }
  if (gateFailures.length) reading = "gate_failure";
  return {
    ok: errors.length === 0,
    reading,
    claim_level: reading === "informative" ? "descriptive" : "feasibility_only",
    efficacy_claim_allowed: false,
    findings,
    outcomes: readings,
    ledgers,
  };
}
