import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import {
  attemptOps,
  continuityOps,
  questionOps,
  attemptRecoveryOps as recoveryOps,
  schema,
} from "@tila/ops-sqlite";
import {
  AttemptViewSchema,
  PaginatedEntityListResponseSchema,
  UnifiedSearchResponseSchema,
} from "@tila/schemas";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { expect, it } from "vitest";
import {
  attemptOrigin,
  authority,
} from "../../ops-sqlite/test/attempt-fixture";
import {
  correlation,
  prepare,
  responder,
  worker,
} from "../../ops-sqlite/test/question-contract";
import { post } from "./helpers";
import { member, queueApiFixture } from "./queue-api-fixture";
import { bindings } from "./setup";

// These compose actual local DO persistence operations. Synthetic identities,
// sessions and evidence aliases are not native/live acceptance or uploaded blobs.
it("S1 walks all 301 custom tasks and search hits through eviction without truncation", async () => {
  const stub = bindings.PROJECT.get(bindings.PROJECT.newUniqueId());
  const definition =
    'schema_version = 1\n[work_units.bug.fields.title]\ntype = "string"\n[work_units.empty.fields.title]\ntype = "string"\n';
  expect(
    (
      await post(stub, "/schema/apply", {
        definition,
        expected_revision: 0,
        applied_by: "fixture",
      })
    ).status,
  ).toBe(200);
  const expected = Array.from(
    { length: 301 },
    (_, i) => `bug-${String(i).padStart(3, "0")}`,
  );
  for (const id of expected)
    expect(
      (
        await post(stub, "/entity/create", {
          id,
          type: "bug",
          data: { title: `scenario ${id}` },
          created_by: "fixture",
        })
      ).status,
    ).toBe(200);
  const listed: string[] = [];
  let cursor: string | null = null;
  do {
    const query = new URLSearchParams({
      type: "bug",
      limit: "100",
      sort: "id",
    });
    if (cursor) query.set("cursor", cursor);
    const response = await stub.fetch(`https://project/entity/list?${query}`);
    expect(response.status).toBe(200);
    const page = PaginatedEntityListResponseSchema.parse(await response.json());
    expect(page.total).toBe(301);
    listed.push(...page.entities.map((e) => e.id));
    cursor = page.next_cursor ?? null;
    if (listed.length === 100) await evictDurableObject(stub);
  } while (cursor);
  expect(listed).toEqual(expected);
  const searched: string[] = [];
  cursor = null;
  do {
    const query = new URLSearchParams({
      q: "scenario",
      kind: "task",
      limit: "100",
    });
    if (cursor) query.set("cursor", cursor);
    const response = await stub.fetch(`https://project/search?${query}`);
    expect(response.status, await response.clone().text()).toBe(200);
    const page = UnifiedSearchResponseSchema.parse(await response.json());
    for (const hit of page.results) {
      if (hit.type !== "entity") throw new Error("Expected task search result");
      searched.push(hit.entity_id);
    }
    cursor = page.next_cursor ?? null;
    if (searched.length === 100) await evictDurableObject(stub);
  } while (cursor);
  expect(searched.sort()).toEqual(expected);
  expect(new Set(searched).size).toBe(301);
});

it("S1 serializes three revisionful client-shaped edits and rejects a stale original file", async () => {
  const stub = bindings.PROJECT.get(bindings.PROJECT.newUniqueId());
  const original =
    'schema_version = 1\n[work_units.bug.fields.title]\ntype = "string"\n';
  expect(
    (
      await post(stub, "/schema/apply", {
        definition: original,
        expected_revision: 0,
        applied_by: "file-bootstrap",
      })
    ).status,
  ).toBe(200);
  const responses = await Promise.all(
    ["ui", "cli", "mcp"].map((client) =>
      post(stub, "/schema/apply", {
        definition: `${original}\n# ${client}`,
        applied_by: client,
        expected_revision: 1,
        idempotency_key: `edit-${client}`,
      }),
    ),
  );
  expect(responses.map((r) => r.status).sort()).toEqual([200, 412, 412]);
  await evictDurableObject(stub);
  expect(
    (
      await post(stub, "/schema/apply", {
        definition: original,
        expected_revision: 1,
        applied_by: "stale-file",
      })
    ).status,
  ).toBe(412);
  const history = await (
    await stub.fetch("https://project/schema/history")
  ).json<{ entries: unknown[] }>();
  expect(history.entries).toHaveLength(2);
});

it("S2 retains two distinct answers and one logical replay effect across outage and replacement", async () => {
  const stub = bindings.PROJECT.get(bindings.PROJECT.newUniqueId());
  const fixture = await runInDurableObject(stub, (_instance, state) => {
    const db = drizzle(state.storage, { schema });
    const { attempt, q, command, now } = prepare(db);
    const second = questionOps.ask(
      db,
      {
        ...command,
        id: crypto.randomUUID(),
        idempotency_key: "question-2",
        text: "Which region?",
      },
      worker,
      now,
    ).question;
    const started = attemptOps.started(
      db,
      attempt.id,
      {
        ...authority(attempt),
        session: { provider: "fixture", id: "old-session" },
      },
      attemptOrigin,
      now,
    ).attempt;
    expect(started.outcome).toBeNull();
    return { attempt: started, q, second, now };
  });
  await evictDurableObject(stub);
  const acknowledged = await runInDurableObject(stub, (_instance, state) => {
    const db = drizzle(state.storage, { schema });
    const { q, second, now } = fixture;
    const first = { ...correlation(q, "answer-1"), text: "Migration 36" };
    questionOps.answer(db, q.id, first, responder, now + 1);
    const owner = {
      ...responder,
      is_owner: true,
      origin: { ...responder.origin, principalId: "owner" },
    };
    const escalated = questionOps.escalate(
      db,
      second.id,
      {
        ...correlation(second, "escalate"),
        responder_principal_id: "owner",
        reason: "Region approval",
      },
      responder,
      now + 2,
    ).question;
    const last = { ...correlation(escalated, "answer-2"), text: "EU" };
    questionOps.answer(db, second.id, last, owner, now + 3);
    const replay = continuityOps.replaySnapshot(db, { after_seq: 0 });
    continuityOps.acknowledge(
      db,
      {
        principal_id: "worker",
        participant_id: "worker-process",
        environment: {},
      },
      { seq: replay.through_seq },
    );
    return { first, last, owner, through: replay.through_seq };
  });
  await evictDurableObject(stub);
  await runInDurableObject(stub, (_instance, state) => {
    const db = drizzle(state.storage, { schema });
    const { attempt, q, second, now } = fixture;
    if (!attempt.session) throw new Error("Expected fixture session");
    questionOps.answer(db, q.id, acknowledged.first, responder, now + 4);
    questionOps.answer(
      db,
      second.id,
      acknowledged.last,
      acknowledged.owner,
      now + 4,
    );
    expect(
      continuityOps.replaySnapshot(db, { after_seq: acknowledged.through })
        .events,
    ).toEqual([]);
    const replaced = recoveryOps.replaceSession(
      db,
      attempt.id,
      {
        ...authority(attempt),
        previous_session: attempt.session,
        previous_stopped: true,
        session: { provider: "fixture", id: "replacement" },
        reason: "synthetic restart",
      },
      attemptOrigin,
      now + 5,
    ).attempt;
    expect(replaced.fence).toBeGreaterThan(attempt.fence);
    expect(replaced.outcome).toBeNull();
    for (const question of [q, second]) {
      const view = questionOps.view(db, question.id, worker, now + 6);
      expect(view.question.answer?.text).toBe(
        question.id === q.id ? "Migration 36" : "EU",
      );
      expect(view.answer_applicable).toBe(false);
    }
    const outcome = {
      status: "success" as const,
      execution_stopped: true,
      unresolved_external_execution: false,
      evidence: ["fixture-result-artifact"],
    };
    expect(() =>
      attemptOps.finish(
        db,
        attempt.id,
        { ...authority({ ...attempt, revision: replaced.revision }), outcome },
        attemptOrigin,
        now + 6,
      ),
    ).toThrow();
    expect(() =>
      attemptOps.finish(
        db,
        attempt.id,
        { ...authority(replaced), outcome },
        { ...attemptOrigin, principalId: "other-worker" },
        now + 6,
      ),
    ).toThrow();
    const finished = attemptOps.finish(
      db,
      attempt.id,
      { ...authority(replaced, "finish"), outcome },
      attemptOrigin,
      now + 7,
    );
    expect(finished.attempt.outcome).toEqual(outcome);
    expect(
      db
        .select()
        .from(schema.journal)
        .all()
        .filter((e) => e.kind === "question.answered"),
    ).toHaveLength(2);
  });
});

it("S2 two local participant principals sharing a participant label cannot exchange grants", async () => {
  const f = await queueApiFixture();
  const workers = [
    await member(f.project, 8301),
    await member(f.project, 8302),
  ];
  await f.queue.configure({
    idempotency_key: "enable",
    expected_revision: 0,
    enabled: true,
    paused: false,
    execution_limit: 2,
  });
  const attempts = [];
  for (const [index, actor] of workers.entries()) {
    const taskId = `assigned-${index}`;
    const created = await f.http("/tasks", {
      id: taskId,
      type: "issue",
      data: { phase: "todo" },
    });
    expect(created.status, await created.text()).toBe(200);
    await f.queue.enroll({
      idempotency_key: `assign-${index}`,
      task_id: taskId,
      target_principal: actor.principal,
    });
    const read = async (response: Response) => {
      expect(response.status, await response.clone().text()).toBe(200);
      return AttemptViewSchema.parse(
        (await response.json<{ result: unknown }>()).result,
      ).attempt;
    };
    let attempt = await read(
      await actor.post(
        "/queue/claim",
        { idempotency_key: "same-key-distinct-principal" },
        "worker",
      ),
    );
    attempt = await read(
      await actor.post(
        `/attempts/${attempt.id}/accept`,
        authority(attempt),
        "worker",
      ),
    );
    attempt = await read(
      await actor.post(
        `/attempts/${attempt.id}/started`,
        {
          ...authority(attempt),
          session: { provider: "fixture", id: `session-${index}` },
        },
        "worker",
      ),
    );
    expect(attempt.task_id).toBe(taskId);
    expect(attempt.principal_id).toBe(actor.principal);
    expect(attempt.outcome).toBeNull();
    attempts.push(attempt);
  }
  expect(attempts[0].id).not.toBe(attempts[1].id);
  await evictDurableObject(
    bindings.PROJECT.get(bindings.PROJECT.idFromName(f.project)),
  );
  const outcome = {
    status: "success",
    execution_stopped: true,
    unresolved_external_execution: false,
    evidence: ["fixture-artifact"],
  };
  for (const [index, attempt] of attempts.entries()) {
    for (const [actor, participant] of [
      [workers[1 - index], "worker"],
      [workers[index], "different-process"],
    ] as const) {
      const denied = await actor.post(
        `/attempts/${attempt.id}/finish`,
        { ...authority(attempt), outcome },
        participant,
      );
      expect(denied.status, await denied.text()).toBe(403);
    }
    const retained = await workers[index].get(
      `/attempts/${attempt.id}`,
      "worker",
    );
    expect(retained.status, await retained.clone().text()).toBe(200);
    expect(
      AttemptViewSchema.parse(
        (await retained.json<{ result: unknown }>()).result,
      ).attempt.outcome,
    ).toBeNull();
  }
});

for (const answerFirst of [true, false])
  it(`S3 retains acknowledged decisions through cancellation and explicit result (answer ${answerFirst ? "first" : "last"})`, async () => {
    const stub = bindings.PROJECT.get(bindings.PROJECT.newUniqueId());
    const fixture = await runInDurableObject(stub, (_instance, state) => {
      const db = drizzle(state.storage, { schema });
      const { attempt, q, now } = prepare(db);
      const answer = {
        ...correlation(q, "answer"),
        text: "Keep original evidence",
      };
      if (answerFirst) questionOps.answer(db, q.id, answer, responder, now + 1);
      const cancelled = recoveryOps.requestCancellation(
        db,
        attempt.id,
        authority(attempt),
        attemptOrigin,
        false,
        now + 2,
      ).attempt;
      if (!answerFirst)
        expect(() =>
          questionOps.answer(db, q.id, answer, responder, now + 3),
        ).toThrow();
      expect(cancelled.outcome).toBeNull();
      const outcome = {
        status: "cancelled" as const,
        execution_stopped: true,
        unresolved_external_execution: false,
        evidence: ["fixture-cancellation-artifact"],
      };
      const command = { ...authority(cancelled, "finish"), outcome };
      attemptOps.finish(db, attempt.id, command, attemptOrigin, now + 4);
      return { attempt, q, answer, outcome, command, now };
    });
    await evictDurableObject(stub);
    await runInDurableObject(stub, (_instance, state) => {
      const db = drizzle(state.storage, { schema });
      const { attempt, q, answer, outcome, command, now } = fixture;
      expect(
        attemptOps.finish(db, attempt.id, command, attemptOrigin, now + 5)
          .attempt.outcome,
      ).toEqual(outcome);
      if (answerFirst) questionOps.answer(db, q.id, answer, responder, now + 5);
      else
        expect(() =>
          questionOps.answer(db, q.id, answer, responder, now + 5),
        ).toThrow();
      const view = questionOps.view(db, q.id, worker, now + 5);
      expect(view.question.answer?.text ?? null).toBe(
        answerFirst ? answer.text : null,
      );
      expect(view.answer_applicable).toBe(false);
      expect(attemptOps.get(db, attempt.id).outcome).toEqual(outcome);
      const events = continuityOps.replaySnapshot(db, { after_seq: 0 }).events;
      expect(events.filter((e) => e.kind === "question.answered")).toHaveLength(
        answerFirst ? 1 : 0,
      );
    });
  });
