import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createTila } from "tila-sdk";
import { afterEach, expect, it } from "vitest";
import { writeConfigFile } from "../../config";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

it("Bun CLI and Node SDK operate one queue with stable participant authority", async () => {
  const root = mkdtempSync(join(tmpdir(), "tila-queue-cli-"));
  roots.push(root);
  const config = {
    backend: "local" as const,
    project_id: "queue-cli",
    schema_version: 0,
    tila_version: "0.5.0",
    created_at: new Date(0).toISOString(),
    local: {
      db_path: join(root, "state.db"),
      artifacts_path: join(root, "artifacts"),
      org: "fixture",
    },
  };
  writeConfigFile(config, join(root, ".tila"));
  const sdk = await createTila(config, undefined, {
    participantId: "shared-worker",
  });
  const cli = resolve("src/index.ts");
  const env = {
    ...process.env,
    CODEX_THREAD_ID: "",
    TILA_LIFECYCLE_KEY: "",
    TILA_RUN_SOCKET: "",
    TILA_RUN_CAPABILITY: "",
  };
  const command = (
    family: string,
    action: string,
    data: unknown = {},
    id?: string,
  ) =>
    JSON.parse(
      execFileSync(
        "bun",
        [
          cli,
          family,
          action,
          ...(id ? [id] : []),
          "--participant-id",
          "shared-worker",
          "--json",
          "--data",
          JSON.stringify(data),
        ],
        { cwd: root, env, encoding: "utf8", timeout: 15000 },
      ),
    );
  try {
    await sdk.schema.apply(
      `schema_version = 1
[work_units.task.lifecycle]
field = "status"
dispatchable = ["open"]
terminal = ["done"]
dependency_satisfied = ["done"]
[work_units.task.fields.status]
type = "enum"
values = ["open", "done"]
`,
      undefined,
      { expected_revision: 0 },
    );
    await sdk.tasks.create("one", "task", { status: "open" });
    expect(
      command("queue", "configure", {
        idempotency_key: "enable",
        expected_revision: 0,
        enabled: true,
        paused: false,
        execution_limit: 1,
      }).ok,
    ).toBe(true);
    command("queue", "enroll", { idempotency_key: "enroll", task_id: "one" });
    const grant = command("queue", "claim", {
      idempotency_key: "claim",
    }).result;
    expect(grant.kind).toBe("granted");
    let attempt = (
      await sdk.attempts.accept(grant.attempt.id, {
        idempotency_key: "accept",
        expected_revision: grant.attempt.revision,
        fence: grant.attempt.fence,
      })
    ).attempt;
    const q = command("question", "ask", {
      id: crypto.randomUUID(),
      idempotency_key: "question-ask",
      attempt_id: attempt.id,
      expected_revision: attempt.revision,
      fence: attempt.fence,
      text: "Continue?",
      responder_principal_id: "local:fixture",
    }).result.question;
    const answer = {
      question_id: q.id,
      idempotency_key: "question-answer",
      expected_revision: q.revision,
      attempt_id: q.attempt_id,
      attempt_revision: q.attempt_revision,
      attempt_fence: q.attempt_fence,
      text: "yes",
    };
    await sdk.questions.answer(q.id, answer);
    expect(command("question", "get", {}, q.id).result.answer_applicable).toBe(
      true,
    );
    expect(
      command("question", "answer", answer, q.id).result.question.answer.text,
    ).toBe("yes");
    expect(
      command("question", "list", { state: "answered" }).result.questions,
    ).toHaveLength(1);
    attempt = command(
      "attempt",
      "request-cancellation",
      { idempotency_key: "cancel", expected_revision: attempt.revision },
      attempt.id,
    ).result.attempt;
    expect((await sdk.queue.inspect()).counts.execution).toBe(1);
    command(
      "attempt",
      "finish",
      {
        idempotency_key: "finish",
        expected_revision: attempt.revision,
        fence: attempt.fence,
        outcome: {
          status: "cancelled",
          execution_stopped: true,
          unresolved_external_execution: false,
          evidence: [],
        },
      },
      attempt.id,
    );
    expect((await sdk.queue.inspect()).counts.execution).toBe(0);
    expect(command("question", "get", {}, q.id).result.answer_applicable).toBe(
      false,
    );
    expect(command("attempt", "list").result.items).toHaveLength(1);
  } finally {
    sdk.close();
  }
  // Every step spawns `bun src/index.ts`, which compiles the CLI from source;
  // under parallel CI load the whole journey can pass 30s without hanging.
}, 90_000);
