import type { Question } from "@tila/schemas";
import { expect } from "vitest";
import * as attempts from "../src/attempt-ops";
import * as recovery from "../src/attempt-recovery-ops";
import * as questions from "../src/question-ops";
import type { ProjectDatabase } from "../src/queue-internals";
import * as s from "../src/schema";
import { attemptOrigin, authority, seedAttempt } from "./attempt-fixture";

export const worker: questions.QuestionAuthority = {
  origin: attemptOrigin,
  can_manage: false,
  is_owner: false,
  conversation: {
    principal_id: attemptOrigin.principalId,
    participant_id: attemptOrigin.participantId,
    can_manage: false,
    runtime: null,
  },
};
export const responder: questions.QuestionAuthority = {
  origin: {
    ...attemptOrigin,
    principalId: "orchestrator",
    participantId: "orchestrator-process",
    actor: "orchestrator",
  },
  can_manage: false,
  is_owner: false,
  conversation: {
    principal_id: "orchestrator",
    participant_id: "orchestrator-process",
    can_manage: false,
    runtime: null,
  },
};
export function correlation(q: Question, key: string = crypto.randomUUID()) {
  return {
    question_id: q.id,
    idempotency_key: key,
    expected_revision: q.revision,
    attempt_id: q.attempt_id,
    attempt_revision: q.attempt_revision,
    attempt_fence: q.attempt_fence,
  };
}
export function prepare(db: ProjectDatabase, now = Date.now()) {
  const reserved = seedAttempt(db, "task", now);
  const attempt = attempts.accept(
    db,
    reserved.id,
    authority(reserved),
    attemptOrigin,
    now,
  ).attempt;
  const command = {
    ...authority(attempt),
    id: crypto.randomUUID(),
    attempt_id: attempt.id,
    text: "Which migration?",
    responder_principal_id: "orchestrator",
  };
  return {
    now,
    attempt,
    command,
    q: questions.ask(db, command, worker, now).question,
  };
}
export const questionCases: Record<string, (db: ProjectDatabase) => void> = {
  "keeps simultaneous questions distinct and replays only identical authorized answers":
    (db) => {
      const { q, command } = prepare(db);
      const second = questions.ask(
        db,
        {
          ...command,
          id: crypto.randomUUID(),
          idempotency_key: "second",
          text: "Which region?",
        },
        worker,
      ).question;
      const input = { ...correlation(q), text: "Use migration 36" };
      const answer = questions.answer(db, q.id, input, responder);
      expect(answer.question.answer?.text).toBe(input.text);
      expect(questions.answer(db, q.id, input, responder)).toEqual(answer);
      expect(questions.view(db, q.id, worker).answer_applicable).toBe(true);
      expect(questions.get(db, second.id).state).toBe("open");
      expect(() =>
        questions.answer(db, q.id, { ...input, text: "different" }, responder),
      ).toThrow("different request");
      expect(() => questions.answer(db, second.id, input, responder)).toThrow(
        "correlation",
      );
      expect(() =>
        questions.answer(
          db,
          q.id,
          { ...input, idempotency_key: "other" },
          responder,
        ),
      ).toThrow("revision");
      expect(db.select().from(s.questionReceipts).all()).toHaveLength(3);
    },
  "rejects wrong actors and exact attempt correlation mismatches": (db) => {
    const { q } = prepare(db);
    const input = { ...correlation(q), text: "yes" };
    expect(() => questions.answer(db, q.id, input, worker)).toThrow(
      "not authorized",
    );
    for (const mismatch of [
      { attempt_id: "other" },
      { attempt_fence: 99 },
      { attempt_revision: 99 },
    ])
      expect(() =>
        questions.answer(db, q.id, { ...input, ...mismatch }, responder),
      ).toThrow("correlation");
    expect(questions.get(db, q.id).answer).toBeNull();
  },
  "heartbeats and initial session attachment preserve answer context": (db) => {
    const { q, attempt, now } = prepare(db);
    const beat = attempts.heartbeat(
      db,
      attempt.id,
      authority(attempt),
      attemptOrigin,
      now + 1,
    ).attempt;
    attempts.started(
      db,
      attempt.id,
      { ...authority(beat), session: { provider: "test", id: "session" } },
      attemptOrigin,
      now + 2,
    );
    questions.answer(
      db,
      q.id,
      { ...correlation(q), text: "yes" },
      responder,
      now + 3,
    );
    expect(questions.view(db, q.id, worker, now + 4).answer_applicable).toBe(
      true,
    );
  },
  "retains offline answers as evidence and requires a new question after recovery":
    (db) => {
      const { q, attempt, command, now } = prepare(db);
      const started = attempts.started(
        db,
        attempt.id,
        { ...authority(attempt), session: { provider: "test", id: "session" } },
        attemptOrigin,
        now,
      ).attempt;
      attempts.expire(db, now + 70_000);
      const uncertain = attempts.get(db, started.id);
      questions.answer(
        db,
        q.id,
        { ...correlation(q), text: "yes" },
        responder,
        now + 70_000,
      );
      expect(
        questions.view(db, q.id, worker, now + 70_000).answer_applicable,
      ).toBe(false);
      const rebound = recovery.rebind(
        db,
        uncertain.id,
        {
          ...authority(uncertain),
          reason: "recovered",
          principal_id: attemptOrigin.principalId,
          participant_id: attemptOrigin.participantId,
          session: { provider: "test", id: "session" },
        },
        attemptOrigin,
        true,
        now + 70_001,
      ).attempt;
      expect(questions.get(db, q.id).answer?.text).toBe("yes");
      expect(
        questions.view(db, q.id, worker, now + 70_002).answer_applicable,
      ).toBe(false);
      const fresh = questions.ask(
        db,
        {
          ...command,
          ...authority(rebound),
          id: crypto.randomUUID(),
          predecessor_id: q.id,
        },
        worker,
        now + 70_002,
      ).question;
      questions.answer(
        db,
        fresh.id,
        { ...correlation(fresh), text: "confirmed" },
        responder,
        now + 70_003,
      );
      expect(
        questions.view(db, fresh.id, worker, now + 70_004).answer_applicable,
      ).toBe(true);
    },
  "cancellation first supersedes pending answers in the same transaction": (
    db,
  ) => {
    const { q, attempt } = prepare(db);
    recovery.requestCancellation(
      db,
      attempt.id,
      authority(attempt),
      attemptOrigin,
    );
    expect(questions.get(db, q.id).state).toBe("superseded");
    expect(() =>
      questions.answer(db, q.id, { ...correlation(q), text: "yes" }, responder),
    ).toThrow();
    expect(questions.get(db, q.id).answer).toBeNull();
  },
  "answer first retains evidence after cancellation or terminal completion": (
    db,
  ) => {
    const { q, attempt } = prepare(db);
    questions.answer(db, q.id, { ...correlation(q), text: "yes" }, responder);
    const cancelled = recovery.requestCancellation(
      db,
      attempt.id,
      authority(attempt),
      attemptOrigin,
    ).attempt;
    attempts.finish(
      db,
      attempt.id,
      {
        ...authority(cancelled),
        outcome: {
          status: "cancelled",
          execution_stopped: true,
          evidence: [],
          unresolved_external_execution: false,
        },
      },
      attemptOrigin,
    );
    expect(questions.get(db, q.id).state).toBe("answered");
    expect(questions.get(db, q.id).answer?.text).toBe("yes");
    expect(questions.view(db, q.id, worker).answer_applicable).toBe(false);
  },
  "escalation transfers answer ownership and requires current owner authority":
    (db) => {
      const { q } = prepare(db);
      const escalation = {
        ...correlation(q),
        responder_principal_id: "owner",
        reason: "budget",
      };
      const escalated = questions.escalate(
        db,
        q.id,
        escalation,
        responder,
      ).question;
      expect(
        questions.escalate(db, q.id, escalation, responder).question,
      ).toEqual(escalated);
      expect(() =>
        questions.escalate(
          db,
          q.id,
          { ...escalation, idempotency_key: "new-key" },
          responder,
        ),
      ).toThrow("not authorized");
      const input = { ...correlation(escalated), text: "approved" };
      expect(escalated.routing).toHaveLength(2);
      expect(() => questions.answer(db, q.id, input, responder)).toThrow(
        "not authorized",
      );
      const owner = {
        ...responder,
        origin: { ...responder.origin, principalId: "owner" },
      };
      expect(() => questions.answer(db, q.id, input, owner)).toThrow(
        "not authorized",
      );
      expect(
        questions.answer(db, q.id, input, { ...owner, is_owner: true }).question
          .answer?.actor.principal_id,
      ).toBe("owner");
    },
  "rolls back answer state receipt and journal together": (db) => {
    const { q } = prepare(db);
    const before = db.select().from(s.journal).all();
    expect(() =>
      db.transaction((tx) => {
        questions.answer(
          tx,
          q.id,
          { ...correlation(q), text: "yes" },
          responder,
        );
        throw new Error("abort transaction");
      }),
    ).toThrow("abort transaction");
    expect(questions.get(db, q.id).state).toBe("open");
    expect(db.select().from(s.questionReceipts).all()).toHaveLength(1);
    expect(db.select().from(s.journal).all()).toEqual(before);
  },
  "filters pending questions and paginates without leaking forbidden tasks": (
    db,
  ) => {
    const { command } = prepare(db);
    questions.ask(
      db,
      { ...command, id: crypto.randomUUID(), idempotency_key: "second" },
      worker,
    );
    const first = questions.list(
      db,
      { state: "open", responder_principal_id: "orchestrator", limit: 1 },
      responder,
    );
    expect(first.questions).toHaveLength(1);
    if (!first.next_after_id) throw new Error("Expected next page");
    const second = questions.list(
      db,
      { after_id: first.next_after_id, limit: 1 },
      responder,
    );
    expect(second.questions).toHaveLength(1);
    expect(second.questions[0].question.id).not.toBe(
      first.questions[0].question.id,
    );
    expect(second.next_after_id).toBeNull();
    expect(questions.list(db, {}, responder, () => false).questions).toEqual(
      [],
    );
  },
};
