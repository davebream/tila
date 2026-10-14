#!/usr/bin/env node
/**
 * Worker-facing entry points for the #194 pilot. It never imports the fixtures module, so
 * nothing a worker can run here carries acceptance cases or reference solutions.
 *
 *   sdk         --run-dir R --trial T --participant P <verb> [args]   logged SDK-facade call (condition B)
 *   tila        --run-dir R --trial T --participant P -- <cli args>  logged source-CLI call (condition B)
 *   budget-hook --run-dir R --trial T --role w1                        Claude Code PreToolUse hook, both conditions
 *
 * The budget hook is the single, identical enforcement and counting path for both conditions:
 * it counts every submitted tool call against the per-role bound, denies calls after the wall
 * deadline or the bound, denies reads of hidden study files, and records the replacement
 * context and its RESUME note. It runs on the host; it is unverified inside any given agent
 * runtime until the run lead smoke-tests it once.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  appendEvent,
  appendEventsWith,
  baseRole,
  categorizeToolCall,
  monotonicMs,
  sha256Text,
} from "./dogfood-study-lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const rubric = JSON.parse(
  readFileSync(
    join(repoRoot, "docs/evidence/issue-194-rubric-v1.json"),
    "utf8",
  ),
);

function parseArgs(argv) {
  const opts = {};
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--") {
      rest.push(...argv.slice(i + 1));
      break;
    }
    if (
      a.startsWith("--") &&
      ["run-dir", "trial", "participant", "role"].includes(a.slice(2))
    ) {
      i += 1;
      opts[a.slice(2)] = argv[i];
    } else {
      rest.push(a);
    }
  }
  return { opts, rest };
}

function loadTrial(opts) {
  const dir = join(resolve(opts["run-dir"]), "trials", opts.trial);
  const config = JSON.parse(readFileSync(join(dir, "trial.json"), "utf8"));
  return { dir, config, events: join(dir, "events.jsonl") };
}

function roleOf(config, participant) {
  const entry = Object.entries(config.participants).find(
    ([, p]) => p === participant,
  );
  return entry ? entry[0] : "orch";
}

function classify(result) {
  if (result?.ok === true) return "ok";
  const kind = result?.error?.kind ?? "";
  if (["already-held", "conflict"].includes(kind)) return "conflict";
  if (kind === "stale-fence") return "stale_fence";
  if (kind === "not-found") return "not_found";
  return "error";
}

function logCall(file, role, payload) {
  appendEvent(
    file,
    { kind: "tila_call", actor: { role }, payload: { role, ...payload } },
    rubric,
  );
}

async function main() {
  const [command, ...argv] = process.argv.slice(2);
  const { opts, rest } = parseArgs(argv);
  if (command === "budget-hook") return budgetHook(opts);
  const { dir, config, events } = loadTrial(opts);
  const role = roleOf(config, opts.participant);
  if (command === "sdk") {
    const [verb, ...args] = rest;
    const tsx = join(repoRoot, "node_modules/.bin/tsx");
    const out = spawnSync(
      tsx,
      [
        "--tsconfig",
        join(repoRoot, "tsconfig.json"),
        join(here, "dogfood-study-sdk.ts"),
        join(dir, "store.json"),
        opts.participant,
        verb,
        ...args,
      ],
      { encoding: "utf8", cwd: repoRoot },
    );
    let result;
    try {
      result = JSON.parse(out.stdout.trim().split("\n").pop());
    } catch {
      result = {
        ok: false,
        error: {
          kind: "error",
          message: (out.stderr || out.stdout).slice(0, 300),
        },
      };
    }
    logCall(events, role, {
      verb: `sdk ${verb}`,
      resource: verb === "handoff-create" ? undefined : args[0],
      presented_fence:
        Number.isFinite(Number(args[args.indexOf("--fence") + 1])) &&
        args.includes("--fence")
          ? Number(args[args.indexOf("--fence") + 1])
          : undefined,
      fence: result.fence,
      outcome: classify(result),
      status: result.error?.status,
    });
    console.log(JSON.stringify(result));
    process.exit(result.ok ? 0 : 1);
  }
  if (command === "tila") {
    const verb = rest.slice(0, 2).join(" ");
    if (verb === "task claim") {
      console.error(
        "Use `sdk claim task:<id>`: the CLI `task claim` report is not reliable for a lost claim (KL-cli-claim-report).",
      );
      process.exit(2);
    }
    const worktree = config.worktrees[baseRole(role)] ?? config.worktrees.w1;
    const cli = join(repoRoot, "packages/cli/src/index.ts");
    const out = spawnSync(
      "bun",
      [
        "--tsconfig-override",
        join(repoRoot, "tsconfig.json"),
        cli,
        ...rest,
        ...(rest.includes("--json") ? [] : ["--json"]),
      ],
      {
        encoding: "utf8",
        cwd: worktree,
        env: {
          ...process.env,
          TILA_PARTICIPANT_ID: opts.participant,
          TILA_MACHINE: config.machine_label,
        },
      },
    );
    const stdout = out.stdout.trim();
    const stderr = out.stderr
      .split("\n")
      .filter((l) => !l.includes("directory mismatch"))
      .join("\n")
      .trim();
    let parsed;
    try {
      parsed = JSON.parse(stdout || stderr.split("\n").pop());
    } catch {
      parsed = { ok: out.status === 0 };
    }
    const fenceAt = rest.indexOf("--fence");
    const fields = {};
    rest.forEach((a, i) => {
      if (a === "--field" && rest[i + 1]?.includes("=")) {
        const [k, ...v] = rest[i + 1].split("=");
        fields[k] = v.join("=");
      }
    });
    logCall(events, role, {
      verb,
      resource: rest[2],
      presented_fence: fenceAt === -1 ? undefined : Number(rest[fenceAt + 1]),
      fields: Object.keys(fields).length ? fields : undefined,
      outcome: classify(parsed),
      detail: parsed?.error?.message?.slice(0, 160),
    });
    if (verb === "task update" && classify(parsed) === "ok") {
      if (fields.decision_ack) {
        appendEvent(
          events,
          {
            kind: "decision.acked",
            actor: { role },
            payload: { decision_id: fields.decision_ack, role, system: "tila" },
          },
          rubric,
        );
      }
      const ref = fields.result_commit ?? fields.reaffirmed;
      if (ref) {
        appendEvent(
          events,
          {
            kind: "result.declared",
            actor: { role },
            payload: {
              role,
              kind: "task_status",
              explicit_ref: ref,
              reaffirmed: fields.reaffirmed !== undefined,
              source: "wrapper_after_success",
            },
          },
          rubric,
        );
      }
    }
    if (stdout) console.log(stdout);
    if (stderr) console.error(stderr);
    process.exit(out.status ?? 1);
  }
  console.error("usage: dogfood-study-tila.mjs sdk|tila|budget-hook ...");
  process.exit(64);
}

// ---------------------------------------------------------------------------

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

const TASK_CATEGORIES = [
  "edit",
  "tila_cli",
  "tila_sdk",
  "git",
  "shell_test",
  "board_edit",
];

async function budgetHook(opts) {
  let decision = { allow: true };
  try {
    const input = JSON.parse((await readStdin()) || "{}");
    const { config, events } = loadTrial(opts);
    const role = opts.role;
    const toolInput = input.tool_input ?? {};
    const path = toolInput.file_path ?? toolInput.path ?? "";
    const category = categorizeToolCall(input.tool_name ?? "", {
      command: toolInput.command ?? "",
      path,
    });
    const serialized = JSON.stringify(toolInput).toLowerCase();
    const sessionId = input.session_id ?? "unknown";
    const cap = rubric.budgets.tool_calls_per_role_per_trial;
    const wall = rubric.budgets.wall_ms_per_trial;

    appendEventsWith(events, rubric, (existing) => {
      const out = [];
      const started = existing.find((e) => e.kind === "trial.started");
      const known = existing.filter(
        (e) => e.kind === "worker.started" && baseRole(e.payload.role) === role,
      );
      const sessions = known.map((e) => e.payload.session_id);
      let actor = known.length ? known[known.length - 1].payload.role : role;
      if (!sessions.includes(sessionId)) {
        const replacement = known.length > 0;
        actor = replacement ? `${role}r` : role;
        const participant = config.participants[actor];
        out.push({
          kind: "worker.started",
          actor: { role: actor },
          payload: {
            role: actor,
            participant,
            context: replacement ? "replacement" : "original",
            session_id: sessionId,
          },
        });
        if (replacement) {
          out.push({
            kind: "worker.replaced",
            actor: { role: "harness" },
            payload: {
              role,
              from_participant: config.participants[role],
              to_participant: participant,
            },
          });
          out.push({
            kind: "recovery.started",
            actor: { role: actor },
            payload: { role: actor, participant },
          });
        }
      }
      const used = existing.filter(
        (e) =>
          e.kind === "tool_call" &&
          baseRole(e.actor.role) === role &&
          !e.payload.denied,
      ).length;
      let denied = null;
      if (!started) denied = "trial_not_started";
      else if (monotonicMs() - started.mono_ms > wall) denied = "wall_budget";
      else if (used >= cap) denied = "tool_call_budget";
      else if (
        config.hidden_patterns.some((p) => serialized.includes(p.toLowerCase()))
      )
        denied = "hidden_study_file";
      out.push({
        kind: "tool_call",
        actor: { role: actor },
        payload: {
          role: actor,
          category,
          source: "hook",
          tool: input.tool_name,
          tool_use_id: input.tool_use_id ?? null,
          session_id: sessionId,
          agent_id: input.agent_id ?? null,
          denied: denied !== null,
          reason: denied ?? undefined,
        },
      });
      if (denied) {
        decision = { allow: false, reason: denied };
        return out;
      }
      // Acknowledgements and results are recorded from the call itself; nothing is inferred later.
      // The evaluator cross-checks each against the final shared files.
      const raw = JSON.stringify(toolInput);
      const ack = /ACK\s+(D\d+)\s+(w[12]r?)/.exec(raw);
      if (ack) {
        out.push({
          kind: "decision.acked",
          actor: { role: actor },
          payload: { decision_id: ack[1], role: actor, system: "board" },
        });
      }
      const result =
        /\b(RESULT|REAFFIRM)\s+(w[12]r?)\s+([0-9a-f]{7,40})\b/.exec(raw);
      if (result) {
        out.push({
          kind: "result.declared",
          actor: { role: actor },
          payload: {
            role: actor,
            kind: "board",
            explicit_ref: result[3],
            reaffirmed: result[1] === "REAFFIRM",
            source: "hook_pre_execution",
          },
        });
      }
      // Replacement bookkeeping. A lexical match is only a candidate; a reviewer confirms the rule.
      const isReplacement = actor.endsWith("r");
      const mentionsResume =
        /RESUME\.txt/.test(path) || /RESUME\.txt/.test(raw);
      if (isReplacement && mentionsResume) {
        const text = [
          toolInput.content,
          toolInput.new_string,
          toolInput.command,
        ]
          .filter((v) => typeof v === "string")
          .join("\n");
        const line = /DECISION:[^\n"']*/i.exec(text)?.[0] ?? "";
        const lower = line.toLowerCase();
        const candidate =
          lower.includes(config.decision.id.toLowerCase()) &&
          config.decision.key_phrases.some((k) =>
            lower.includes(k.toLowerCase()),
          );
        if (line) {
          out.push({
            kind: "recovery.decision_stated",
            actor: { role: actor },
            payload: { role: actor, candidate, text_sha256: sha256Text(line) },
          });
        }
      } else if (isReplacement && TASK_CATEGORIES.includes(category)) {
        const stated = existing.some(
          (e) =>
            e.kind === "recovery.decision_stated" &&
            e.payload.candidate === true,
        );
        const done = existing.some((e) => e.kind === "recovery.first_action");
        if (stated && !done) {
          out.push({
            kind: "recovery.first_action",
            actor: { role: actor },
            payload: { role: actor, valid: true },
          });
        }
      }
      return out;
    });
  } catch (error) {
    // Fail closed and make the failure visible: a trial with a hook failure is invalid.
    try {
      const { events } = loadTrial(opts);
      appendEvent(
        events,
        {
          kind: "harness.note",
          actor: { role: "harness" },
          payload: {
            topic: "hook_failure",
            text: String(error.message).slice(0, 200),
          },
        },
        rubric,
      );
    } catch {
      // the marker could not be written; the denial below still blocks the call
    }
    console.error(`study budget hook failed closed: ${error.message}`);
    process.exit(2);
  }
  if (!decision.allow) {
    process.stdout.write(
      `${JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: `Study budget: tool call denied (${decision.reason}).`,
        },
      })}\n`,
    );
  }
  process.exit(0);
}

await main();
