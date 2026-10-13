import type { AttemptBackend, QueueBackend } from "@tila/core";
import {
  type AttemptRequest,
  AttemptRequestSchema,
  type QueueRequest,
  QueueRequestSchema,
} from "@tila/schemas";
export function executeQueueRequest(queue: QueueBackend, raw: QueueRequest) {
  const input = QueueRequestSchema.parse(raw);
  switch (input.action) {
    case "policy":
      return queue.policy();
    case "inspect":
      return queue.inspect(input.query);
    case "configure":
      return queue.configure(input.command);
    case "enroll":
      return queue.enroll(input.command);
    case "edit":
      return queue.edit(input.id, input.command);
    case "withdraw":
      return queue.withdraw(input.id, input.command);
    case "claim":
      return queue.claimNext(input.command);
  }
}
export function executeAttemptRequest(
  attempts: AttemptBackend,
  raw: AttemptRequest,
) {
  const input = AttemptRequestSchema.parse(raw);
  switch (input.action) {
    case "get":
      return attempts.get(input.id);
    case "list":
      return attempts.list(input.query);
    case "accept":
      return attempts.accept(input.id, input.command);
    case "started":
      return attempts.started(input.id, input.command);
    case "heartbeat":
      return attempts.heartbeat(input.id, input.command);
    case "finish":
      return attempts.finish(input.id, input.command);
    case "request-suspension":
      return attempts.requestSuspension(input.id, input.command);
    case "confirm-suspension":
      return attempts.confirmSuspension(input.id, input.command);
    case "request-resume":
      return attempts.requestResume(input.id, input.command);
    case "claim-resume":
      return attempts.claimResume(input.id, input.command);
    case "request-cancellation":
      return attempts.requestCancellation(input.id, input.command);
    case "reconcile":
      return attempts.reconcile(input.id, input.command);
    case "rebind":
      return attempts.rebind(input.id, input.command);
    case "retry":
      return attempts.retry(input.id, input.command);
    case "force-recovery":
      return attempts.forceRecovery(input.id, input.command);
    case "replace-session":
      return attempts.replaceSession(input.id, input.command);
    case "correct":
      return attempts.correct(input.id, input.command);
  }
}

export function queueFacade(backend: QueueBackend): QueueBackend {
  return {
    policy: backend.policy.bind(backend),
    inspect: backend.inspect.bind(backend),
    configure: backend.configure.bind(backend),
    enroll: backend.enroll.bind(backend),
    edit: backend.edit.bind(backend),
    withdraw: backend.withdraw.bind(backend),
    claimNext: backend.claimNext.bind(backend),
  };
}

export function attemptFacade(backend: AttemptBackend): AttemptBackend {
  return {
    get: backend.get.bind(backend),
    list: backend.list.bind(backend),
    accept: backend.accept.bind(backend),
    started: backend.started.bind(backend),
    heartbeat: backend.heartbeat.bind(backend),
    finish: backend.finish.bind(backend),
    requestSuspension: backend.requestSuspension.bind(backend),
    confirmSuspension: backend.confirmSuspension.bind(backend),
    requestResume: backend.requestResume.bind(backend),
    claimResume: backend.claimResume.bind(backend),
    requestCancellation: backend.requestCancellation.bind(backend),
    reconcile: backend.reconcile.bind(backend),
    rebind: backend.rebind.bind(backend),
    retry: backend.retry.bind(backend),
    forceRecovery: backend.forceRecovery.bind(backend),
    replaceSession: backend.replaceSession.bind(backend),
    correct: backend.correct.bind(backend),
  };
}
