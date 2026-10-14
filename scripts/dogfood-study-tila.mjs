#!/usr/bin/env node
/**
 * Worker-facing entry points for the #194 pilot. It never imports the fixtures module, so
 * nothing a worker can run here carries acceptance cases or reference solutions.
 *
 *   sdk         --run-dir R --trial T --participant P <verb> [args]   logged SDK-facade call (condition B)
 *   tila        --run-dir R --trial T --participant P -- <cli args>  logged source-CLI call (condition B)
 *   budget-hook --run-dir R --trial T --role w1                        Codex PreToolUse/PostToolUse hook, both conditions
 *
 * The hook reserves only covered local operations. It requires lead-registered sessions;
 * installed-runtime smoke and complete run-owned coverage evidence remain lead-owned.
 * Board events follow successful durable writes; RESUME candidates follow PostToolUse.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  appendEvent,
  appendEventsWith,
  baseRole,
  categorizeToolCall,
  monotonicMs,
  sha256Text,
  studyCliEnv,
} from "./dogfood-study-lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
let rubric = JSON.parse(
  readFileSync(
    join(repoRoot, "docs/evidence/issue-194-rubric-v3.json"),
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
  if (config.rubric_path)
    rubric = JSON.parse(
      readFileSync(join(repoRoot, config.rubric_path), "utf8"),
    );
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
  if (command === "board") {
    if (config.condition !== "A" || !["w1", "w2", "w1r", "w2r"].includes(role))
      throw new Error("board recorder requires a baseline participant");
    const [action, ref] = rest;
    if (action === "ack" && /^D\d+$/.test(ref ?? "")) {
      appendFileSync(
        join(config.shared, "DECISIONS.md"),
        `ACK ${ref} ${role}\n`,
      );
      appendEvent(
        events,
        {
          kind: "decision.acked",
          actor: { role },
          payload: {
            role,
            decision_id: ref,
            system: "board",
            source: "board_after_write",
          },
        },
        rubric,
      );
    } else if (
      ["result", "reaffirm"].includes(action) &&
      /^[0-9a-f]{7,40}$/.test(ref ?? "")
    ) {
      appendFileSync(
        join(config.shared, "BOARD.md"),
        `${action === "reaffirm" ? "REAFFIRM" : "RESULT"} ${role} ${ref}\n`,
      );
      appendEvent(
        events,
        {
          kind: "result.declared",
          actor: { role },
          payload: {
            role,
            kind: "board",
            explicit_ref: ref,
            reaffirmed: action === "reaffirm",
            source: "board_after_write",
          },
        },
        rubric,
      );
    } else
      throw new Error(
        "board requires ack D1 | result <commit> | reaffirm <commit>",
      );
    return;
  }
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
    if (
      verb === "task update" &&
      rest.filter((a) => a === "--field").length !== 1
    )
      throw new Error(
        "source task update accepts exactly one --field; issue separate updates",
      );
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
        env: studyCliEnv(opts.participant, config.machine_label),
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
      outcome: out.status === 0 ? classify(parsed) : "error",
      detail: parsed?.error?.message?.slice(0, 160),
    });
    if (
      verb === "task update" &&
      out.status === 0 &&
      classify(parsed) === "ok"
    ) {
      const actual = parsed.result?.entity?.data ?? parsed.result?.data;
      if (
        !actual ||
        Object.entries(fields).some(
          ([key, value]) => String(actual[key]) !== value,
        )
      )
        throw new Error(
          "successful task update did not confirm the requested field",
        );
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
  console.error("usage: dogfood-study-tila.mjs sdk|tila|board|budget-hook ...");
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
const nonempty = (v) => typeof v === "string" && v.trim().length > 0;
const snapshotHash = (file) =>
  existsSync(file) ? sha256Text(readFileSync(file, "utf8")) : null;

async function budgetHook(opts) {
  let decision = { allow: true };
  let eventName = "PreToolUse";
  try {
    const input = JSON.parse((await readStdin()) || "{}");
    const { config, events } = loadTrial(opts);
    eventName = input.hook_event_name;
    const role = opts.role;
    if (!["w1", "w2"].includes(role)) throw new Error("unknown base role");
    const identityOk =
      ["PreToolUse", "PostToolUse"].includes(eventName) &&
      [
        input.session_id,
        input.turn_id,
        input.tool_use_id,
        input.tool_name,
      ].every(nonempty);
    const toolInput = input.tool_input ?? {};
    const category = categorizeToolCall(input.tool_name ?? "", {
      command: toolInput.command ?? "",
      path: toolInput.file_path ?? toolInput.path ?? "",
    });
    const serialized = JSON.stringify(toolInput).toLowerCase();
    appendEventsWith(events, rubric, (existing) => {
      const registration = existing.find(
        (e) =>
          e.kind === "worker.started" &&
          e.payload.session_id === input.session_id &&
          baseRole(e.payload.role) === role,
      );
      const actor = registration?.payload.role ?? role;
      const metadata = {
        role: actor,
        category,
        source: "hook",
        tool: input.tool_name ?? null,
        tool_use_id: input.tool_use_id ?? null,
        session_id: input.session_id ?? null,
        turn_id: input.turn_id ?? null,
      };
      const failure = (reason) => ({
        kind: "harness.note",
        actor: { role: "harness" },
        payload: { topic: "hook_failure", text: reason },
      });
      const sameCall = (e) =>
        e.payload.session_id === input.session_id &&
        e.payload.tool_use_id === input.tool_use_id;
      const admitted = existing.find(
        (e) => e.kind === "tool_call" && !e.payload.denied && sameCall(e),
      );
      if (eventName === "PostToolUse") {
        if (
          !identityOk ||
          !registration ||
          !admitted ||
          admitted.payload.turn_id !== input.turn_id ||
          admitted.payload.tool !== input.tool_name
        ) {
          decision = { allow: false, reason: "unpaired_post_event" };
          return failure(decision.reason);
        }
        if (existing.some((e) => e.kind === "tool.completed" && sameCall(e)))
          return null;
        const response = input.tool_response;
        // Unknown response shapes stay unavailable until exact installed-runtime smoke.
        const success =
          typeof response?.exit_code === "number"
            ? response.exit_code === 0
            : typeof response === "string" &&
                /(?:Process exited with code|Exit code:) 0\b/.test(response)
              ? true
              : typeof response === "string" &&
                  /^(?:Success\.|Done!)/.test(response)
                ? true
                : null;
        const out = [
          {
            kind: "tool.completed",
            actor: { role: actor },
            payload: { ...metadata, success },
          },
        ];
        if (
          existing.some(
            (e) =>
              e.kind === "trial.stopped" ||
              (e.kind === "worker.stopped" &&
                e.seq > registration.seq &&
                e.payload.role === actor),
          ) ||
          monotonicMs() -
            existing.find((e) => e.kind === "trial.started").mono_ms >=
            rubric.budgets.wall_ms_per_trial
        )
          return out;
        const resumeFile = join(config.worktrees[role], "RESUME.txt");
        const hash = snapshotHash(resumeFile);
        if (
          actor.endsWith("r") &&
          admitted.payload.resume_write_candidate === true &&
          hash &&
          hash !== admitted.payload.resume_before_sha256 &&
          success === true
        ) {
          const text = readFileSync(resumeFile, "utf8");
          const lower = text.toLowerCase();
          out.push({
            kind: "recovery.decision_stated",
            actor: { role: actor },
            payload: {
              role: actor,
              candidate:
                lower.includes(config.decision.id.toLowerCase()) &&
                config.decision.key_phrases.some((k) =>
                  lower.includes(k.toLowerCase()),
                ),
              text_sha256: hash,
              tool_use_id: input.tool_use_id,
              session_id: input.session_id,
            },
          });
        } else if (
          actor.endsWith("r") &&
          success === true &&
          TASK_CATEGORIES.includes(category) &&
          existing.some(
            (e) =>
              e.kind === "recovery.decision_stated" && e.actor.role === actor,
          ) &&
          !existing.some(
            (e) => e.kind === "recovery.first_action" && e.actor.role === actor,
          )
        ) {
          out.push({
            kind: "recovery.first_action",
            actor: { role: actor },
            payload: {
              role: actor,
              valid: true,
              tool_use_id: input.tool_use_id,
              session_id: input.session_id,
            },
          });
        }
        return out;
      }
      const started = existing.find((e) => e.kind === "trial.started");
      const retired =
        registration &&
        existing.some(
          (e) =>
            e.kind === "worker.stopped" &&
            e.seq > registration.seq &&
            e.payload.role === actor,
        );
      const used = existing.filter(
        (e) =>
          e.kind === "tool_call" &&
          baseRole(e.actor.role) === role &&
          !e.payload.denied,
      ).length;
      const denied = !identityOk
        ? "malformed_hook_identity"
        : !registration
          ? "unregistered_session"
          : existing.some((e) => e.kind === "trial.stopped")
            ? "trial_closed"
            : retired
              ? "retired_session"
              : !started
                ? "trial_not_started"
                : monotonicMs() - started.mono_ms >=
                    rubric.budgets.wall_ms_per_trial
                  ? "wall_budget"
                  : existing.some((e) => e.kind === "tool_call" && sameCall(e))
                    ? "duplicate_delivery"
                    : used >= rubric.budgets.admitted_per_role_per_trial
                      ? "tool_call_budget"
                      : !["Bash", "apply_patch"].includes(input.tool_name)
                        ? "tool_surface_denied"
                        : config.hidden_patterns.some((p) =>
                              serialized.includes(p.toLowerCase()),
                            )
                          ? "hidden_study_file"
                          : null;
      const out = [];
      if (["malformed_hook_identity", "unregistered_session"].includes(denied))
        out.push(failure(denied));
      out.push({
        kind: "tool_call",
        actor: { role: actor },
        payload: {
          ...metadata,
          denied: denied !== null,
          reason: denied ?? undefined,
          resume_before_sha256:
            !denied && actor.endsWith("r")
              ? snapshotHash(join(config.worktrees[role], "RESUME.txt"))
              : undefined,
          resume_write_candidate:
            !denied &&
            /RESUME\.txt/i.test(serialized) &&
            (input.tool_name === "apply_patch" ||
              (input.tool_name === "Bash" &&
                /(?:>|\btee\b)/.test(toolInput.command ?? ""))),
        },
      });
      if (denied) decision = { allow: false, reason: denied };
      return out;
    });
  } catch (error) {
    try {
      const { events } = loadTrial(opts);
      appendEvent(
        events,
        {
          kind: "harness.note",
          actor: { role: "harness" },
          payload: {
            topic: "hook_failure",
            text: "hook state could not be read or recorded",
          },
        },
        rubric,
      );
    } catch {
      /* Preserve broken state; lead must record missing-callback/failure evidence. */
    }
    console.error(`study budget hook failed closed: ${error.message}`);
    process.exit(2);
  }
  if (!decision.allow) {
    if (eventName === "PostToolUse") {
      console.error(`study post hook failed: ${decision.reason}`);
      process.exit(2);
    }
    process.stdout.write(
      `${JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: `Study operation denied (${decision.reason}).`,
        },
      })}\n`,
    );
  }
}

await main();
