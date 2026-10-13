import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import {
  attemptOps,
  continuityOps,
  questionOps,
  schema,
} from "@tila/ops-sqlite";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { expect, it } from "vitest";
import { authority } from "../../ops-sqlite/test/attempt-fixture";
import {
  correlation,
  prepare,
  questionCases,
  responder,
  worker,
} from "../../ops-sqlite/test/question-contract";
import { bindings } from "./setup";

for (const action of ["request-cancellation", "rebind"] as const) {
  for (const answerFirst of [true, false]) {
    it(`serializes concurrent answer and ${action} requests (answer sent ${answerFirst ? "first" : "last"})`, async () => {
      const stub = bindings.PROJECT.get(bindings.PROJECT.newUniqueId());
      const { q, attempt } = await runInDurableObject(
        stub,
        (_instance, state) => {
          const db = drizzle(state.storage, { schema });
          const now = Date.now();
          const fixture = prepare(db, now);
          if (action === "rebind") {
            attemptOps.started(
              db,
              fixture.attempt.id,
              {
                ...authority(fixture.attempt),
                session: { provider: "test", id: "session" },
              },
              worker.origin,
              now,
            );
          }
          return {
            q: fixture.q,
            attempt: attemptOps.get(db, fixture.attempt.id),
          };
        },
      );
      const answerCommand = {
        ...correlation(q, "racing-answer"),
        text: "Proceed",
      };
      const answer = () =>
        stub.fetch("https://do/questions/answer", {
          method: "POST",
          body: JSON.stringify({
            principal_id: responder.origin.principalId,
            participant_id: responder.origin.participantId,
            runtime: null,
            id: q.id,
            command: answerCommand,
          }),
        });
      const invalidate = () =>
        stub.fetch(`https://do/attempts/${action}`, {
          method: "POST",
          body: JSON.stringify({
            principal_id: worker.origin.principalId,
            participant_id: worker.origin.participantId,
            authorized_role: "owner",
            id: attempt.id,
            command: {
              ...authority(attempt),
              ...(action === "rebind"
                ? {
                    reason: "Replace execution context",
                    principal_id: worker.origin.principalId,
                    participant_id: worker.origin.participantId,
                    session: { provider: "test", id: "session" },
                  }
                : {}),
            },
          }),
        });
      const responses = await Promise.all(
        answerFirst ? [answer(), invalidate()] : [invalidate(), answer()],
      );
      const [answered, invalidated] = answerFirst
        ? responses
        : responses.reverse();
      expect(invalidated.status, await invalidated.clone().text()).toBe(200);
      expect([200, 409]).toContain(answered.status);
      await runInDurableObject(stub, (_instance, state) => {
        const db = drizzle(state.storage, { schema });
        const result = questionOps.view(db, q.id, worker);
        expect(result.answer_applicable).toBe(false);
        expect(result.question.invalidation_reason).toBeTruthy();
        expect(result.question.state).toBe(
          answered.ok ? "answered" : "superseded",
        );
        expect(result.question.answer?.text ?? null).toBe(
          answered.ok ? "Proceed" : null,
        );
        expect(db.select().from(schema.questionReceipts).all()).toHaveLength(
          answered.ok ? 2 : 1,
        );
        expect(
          db
            .select()
            .from(schema.journal)
            .all()
            .filter((e) => e.kind === "question.answered"),
        ).toHaveLength(answered.ok ? 1 : 0);
      });
      if (answered.ok) {
        const replay = await answer();
        expect(await replay.json()).toMatchObject({
          result: {
            question: { answer: { text: "Proceed" } },
            answer_applicable: false,
          },
        });
      }
    });
  }
}

for (const [name, run] of Object.entries(questionCases))
  it(`DO: ${name}`, async () => {
    const stub = bindings.PROJECT.get(bindings.PROJECT.newUniqueId());
    await runInDurableObject(stub, (_instance, state) =>
      run(drizzle(state.storage, { schema })),
    );
  });
it("destroys a project that has an open question and report receipts", async () => {
  const stub = bindings.PROJECT.get(bindings.PROJECT.newUniqueId());
  await runInDurableObject(stub, (_instance, state) => {
    const now = Date.now();
    prepare(drizzle(state.storage, { schema }), now);
    state.storage.sql.exec(
      `INSERT INTO journal_report_receipts(key, project_id, principal_id, participant_id, request_hash, response, expires_at)
       VALUES('report-1', 'p', 'worker', 'worker-host', 'hash', '{}', ?)`,
      now + 60_000,
    );
    state.storage.sql.exec(
      "INSERT INTO journal_report_rates(key, window_start, count) VALUES('worker', ?, 1)",
      now,
    );
  });
  const destroyed = await stub.fetch("https://project/admin/destroy", {
    method: "POST",
  });
  expect(destroyed.status, await destroyed.clone().text()).toBe(200);
  const { counts } = await (
    await stub.fetch("https://project/admin/store-counts")
  ).json<{ counts: { domain: Record<string, number> } }>();
  expect(counts.domain).toMatchObject({
    work_questions: 0,
    question_receipts: 0,
    journal_report_receipts: 0,
    journal_report_rates: 0,
  });
  expect(Object.values(counts.domain).every((count) => count === 0)).toBe(true);
});

it("recovers an offline answer after DO eviction and acknowledges its journal position", async () => {
  const stub = bindings.PROJECT.get(bindings.PROJECT.newUniqueId());
  const { q, now } = await runInDurableObject(stub, (_instance, state) =>
    prepare(drizzle(state.storage, { schema })),
  );
  await evictDurableObject(stub);
  await runInDurableObject(stub, (_instance, state) => {
    const db = drizzle(state.storage, { schema });
    questionOps.answer(
      db,
      q.id,
      { ...correlation(q, "answer"), text: "Use the new API" },
      responder,
      now + 1,
    );
  });
  await evictDurableObject(stub);
  await runInDurableObject(stub, (_instance, state) => {
    const db = drizzle(state.storage, { schema });
    const identity = {
      principal_id: worker.origin.principalId,
      participant_id: worker.origin.participantId,
      environment: {},
    };
    const replay = continuityOps.replaySnapshot(db, { after_seq: 0 });
    expect(
      replay.events.filter((e) => e.kind === "question.answered"),
    ).toHaveLength(1);
    expect(questionOps.view(db, q.id, worker, now + 2).answer_applicable).toBe(
      true,
    );
    continuityOps.acknowledge(db, identity, { seq: replay.through_seq });
    expect(
      continuityOps.replaySnapshot(db, {
        after_seq: continuityOps.getCursor(db, identity).seq,
      }).events,
    ).toEqual([]);
  });
});
