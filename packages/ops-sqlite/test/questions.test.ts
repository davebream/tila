import { it } from "vitest";
import { createTestDb } from "./helpers";
import { questionCases } from "./question-contract";

for (const [name, run] of Object.entries(questionCases))
  it(name, () => {
    const fixture = createTestDb();
    try {
      run(fixture.db);
    } finally {
      fixture.rawDb.close();
    }
  });

it("validates discussion links without treating messages as decisions", async () => {
  const { expect } = await import("vitest");
  const { prepare, correlation, worker, responder } = await import(
    "./question-contract"
  );
  const qops = await import("../src/question-ops");
  const conversations = await import("../src/conversation-ops");
  const { db, rawDb } = createTestDb();
  try {
    const { q } = prepare(db);
    const room = { ...worker.conversation, can_manage: true };
    conversations.createRoom(
      db,
      {
        id: "discussion",
        name: "Discussion",
        history_policy: "members",
        delivery_ttl_seconds: 60,
        budgets: {
          max_hops: 8,
          pair_exchanges: 10,
          agent_wakes: 20,
          room_wakes: 60,
        },
      },
      room,
    );
    const { message } = await conversations.publish(
      db,
      "discussion",
      {
        client_op_id: "message",
        body: "yes",
        task_id: q.task_id,
        attempt_id: q.attempt_id,
        correlation_id: q.id,
        targets: [{ kind: "room" }],
        thread_id: null,
        artifact_refs: [],
        reply_expected: false,
      },
      room,
    );
    const input = {
      ...correlation(q),
      discussion: { room_id: "discussion", message_id: message.id },
    };
    expect(() => qops.linkDiscussion(db, q.id, input, responder)).toThrow();
    const linked = qops.linkDiscussion(db, q.id, input, worker).question;
    expect(linked.discussion).toEqual([input.discussion]);
    expect(linked.state).toBe("open");
    expect(linked.answer).toBeNull();
    const second = qops.ask(
      db,
      { ...prepareSecondCommand(q), id: crypto.randomUUID() },
      worker,
    ).question;
    expect(() =>
      qops.linkDiscussion(
        db,
        second.id,
        { ...correlation(second), discussion: input.discussion },
        worker,
      ),
    ).toThrow("reference this question");
    function prepareSecondCommand(question: typeof q) {
      return {
        idempotency_key: "second-question",
        expected_revision: question.attempt_revision,
        fence: question.attempt_fence,
        attempt_id: question.attempt_id,
        text: "Other?",
        responder_principal_id: "orchestrator",
      };
    }
  } finally {
    rawDb.close();
  }
});

it("preserves populated attempts through migration and invalidates restored answer authority", async () => {
  const { expect } = await import("vitest");
  const { prepare, correlation, responder, worker } = await import(
    "./question-contract"
  );
  const questions = await import("../src/question-ops");
  const backup = await import("../src/queue-backup-ops");
  const { MIGRATION_0036 } = await import("../src/migrations-sql");
  const { db, rawDb } = createTestDb();
  try {
    const { q, attempt } = prepare(db);
    questions.answer(db, q.id, { ...correlation(q), text: "yes" }, responder);
    rawDb.exec(MIGRATION_0036);
    backup.invalidateRestoredExecutions(db);
    expect(questions.get(db, q.id).answer?.text).toBe("yes");
    expect(questions.get(db, q.id).invalidation_reason).toBe(
      "project restored",
    );
    expect(questions.view(db, q.id, worker).answer_applicable).toBe(false);
    expect(questions.get(db, q.id).attempt_id).toBe(attempt.id);
  } finally {
    rawDb.close();
  }
});
