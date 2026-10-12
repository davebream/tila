import { expect, test } from "bun:test";
import { attemptOps } from "@tila/ops-sqlite";
import {
  attemptOrigin,
  authority,
  seedAttempt,
} from "../../ops-sqlite/test/attempt-fixture";
import { EmbeddedQuestionBackend } from "../src/embedded-questions";
import { makeHarness } from "./harness.bun";

test("Bun embedded clients retain answers and enforce explicit responder identity", async () => {
  const h = makeHarness();
  try {
    const reserved = seedAttempt(h.db);
    const attempt = attemptOps.accept(
      h.db,
      reserved.id,
      authority(reserved),
      attemptOrigin,
    ).attempt;
    const worker = new EmbeddedQuestionBackend(
      h.db,
      () => attemptOrigin,
      (fn) => fn(),
    );
    const owner = new EmbeddedQuestionBackend(
      h.db,
      () => ({ ...attemptOrigin, principalId: "owner" }),
      (fn) => fn(),
    );
    const { question: q } = await worker.ask({
      ...authority(attempt),
      attempt_id: attempt.id,
      id: crypto.randomUUID(),
      text: "Proceed?",
      responder_principal_id: "owner",
    });
    const command = {
      question_id: q.id,
      idempotency_key: "answer",
      expected_revision: q.revision,
      attempt_id: q.attempt_id,
      attempt_revision: q.attempt_revision,
      attempt_fence: q.attempt_fence,
      text: "yes",
    };
    await expect(worker.answer(q.id, command)).rejects.toThrow(
      "not authorized",
    );
    await owner.answer(q.id, command);
    expect((await worker.get(q.id)).answer_applicable).toBe(true);
    expect((await owner.answer(q.id, command)).question.answer?.text).toBe(
      "yes",
    );
  } finally {
    h.close();
  }
});
