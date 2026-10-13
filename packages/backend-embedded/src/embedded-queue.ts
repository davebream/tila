import type { AttemptBackend, QueueBackend } from "@tila/core";
import {
  type RequestOrigin,
  attemptOps,
  attemptRecoveryOps,
  queueOps,
} from "@tila/ops-sqlite";
import type {
  AttemptAuthorityCommand,
  AttemptFinishCommand,
  AttemptForceCommand,
  AttemptRebindCommand,
  AttemptReconcileCommand,
  AttemptResumeCommand,
  AttemptRetryCommand,
  AttemptStartedCommand,
  AttemptSuspendCommand,
  QueueClaimCommand,
  QueueConfigureCommand,
  QueueEditCommand,
  QueueEnrollCommand,
  QueueListQuery,
  QueueRevisionCommand,
} from "@tila/schemas";
import type { EmbeddedDb } from "./embedded-project";

type Retry = <T>(run: () => T) => T;
/** Embedded stores trust the process owning the database; remote roles remain server-enforced. */
export class EmbeddedQueueBackend implements QueueBackend {
  constructor(
    private db: EmbeddedDb,
    private origin: () => RequestOrigin,
    private withRetry: Retry,
  ) {}
  async policy() {
    return this.withRetry(() => queueOps.policy(this.db));
  }
  async configure(input: QueueConfigureCommand) {
    return this.withRetry(() =>
      queueOps.configure(this.db, input, this.origin(), true),
    );
  }
  async inspect(query?: QueueListQuery) {
    return this.withRetry(() => queueOps.inspect(this.db, query));
  }
  async enroll(input: QueueEnrollCommand) {
    return this.withRetry(() => queueOps.enroll(this.db, input, this.origin()));
  }
  async edit(id: string, input: QueueEditCommand) {
    return this.withRetry(() =>
      queueOps.edit(this.db, id, input, this.origin(), true),
    );
  }
  async withdraw(id: string, input: QueueRevisionCommand) {
    return this.withRetry(() =>
      queueOps.withdraw(this.db, id, input, this.origin(), true),
    );
  }
  async claimNext(input: QueueClaimCommand) {
    return this.withRetry(() =>
      queueOps.claimNext(this.db, input, this.origin()),
    );
  }
}
export class EmbeddedAttemptBackend implements AttemptBackend {
  constructor(
    private db: EmbeddedDb,
    private origin: () => RequestOrigin,
    private withRetry: Retry,
  ) {}
  async get(id: string) {
    return this.withRetry(() => attemptOps.view(this.db, id, this.origin()));
  }
  async list(query?: Parameters<typeof attemptOps.list>[1]) {
    return this.withRetry(() => attemptOps.list(this.db, query));
  }
  async accept(id: string, input: AttemptAuthorityCommand) {
    return this.withRetry(() =>
      attemptOps.accept(this.db, id, input, this.origin()),
    );
  }
  async started(id: string, input: AttemptStartedCommand) {
    return this.withRetry(() =>
      attemptOps.started(this.db, id, input, this.origin()),
    );
  }
  async heartbeat(id: string, input: AttemptAuthorityCommand) {
    return this.withRetry(() =>
      attemptOps.heartbeat(this.db, id, input, this.origin()),
    );
  }
  async finish(id: string, input: AttemptFinishCommand) {
    return this.withRetry(() =>
      attemptOps.finish(this.db, id, input, this.origin()),
    );
  }
  async requestCancellation(id: string, input: QueueRevisionCommand) {
    return this.withRetry(() =>
      attemptRecoveryOps.requestCancellation(
        this.db,
        id,
        input,
        this.origin(),
        true,
      ),
    );
  }

  async requestSuspension(id: string, input: QueueRevisionCommand) {
    return this.withRetry(() =>
      attemptRecoveryOps.requestSuspension(
        this.db,
        id,
        input,
        this.origin(),
        true,
      ),
    );
  }

  async confirmSuspension(id: string, input: AttemptSuspendCommand) {
    return this.withRetry(() =>
      attemptRecoveryOps.confirmSuspension(this.db, id, input, this.origin()),
    );
  }

  async requestResume(id: string, input: QueueRevisionCommand) {
    return this.withRetry(() =>
      attemptRecoveryOps.requestResume(this.db, id, input, this.origin(), true),
    );
  }

  async claimResume(id: string, input: AttemptResumeCommand) {
    return this.withRetry(() =>
      attemptRecoveryOps.claimResume(this.db, id, input, this.origin()),
    );
  }

  async reconcile(id: string, input: AttemptReconcileCommand) {
    return this.withRetry(() =>
      attemptRecoveryOps.reconcile(this.db, id, input, this.origin(), true),
    );
  }

  async rebind(id: string, input: AttemptRebindCommand) {
    return this.withRetry(() =>
      attemptRecoveryOps.rebind(this.db, id, input, this.origin(), true),
    );
  }

  async retry(id: string, input: AttemptRetryCommand) {
    return this.withRetry(() =>
      attemptRecoveryOps.retry(this.db, id, input, this.origin(), true),
    );
  }

  async forceRecovery(id: string, input: AttemptForceCommand) {
    return this.withRetry(() =>
      attemptRecoveryOps.forceRecovery(this.db, id, input, this.origin(), true),
    );
  }
}
