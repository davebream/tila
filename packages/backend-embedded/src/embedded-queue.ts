import type { AttemptBackend, QueueBackend } from "@tila/core";
import { type RequestOrigin, attemptOps, queueOps } from "@tila/ops-sqlite";
import type {
  AttemptAuthorityCommand,
  AttemptFinishCommand,
  AttemptStartedCommand,
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
    private retry: Retry,
  ) {}
  async policy() {
    return this.retry(() => queueOps.policy(this.db));
  }
  async configure(input: QueueConfigureCommand) {
    return this.retry(() =>
      queueOps.configure(this.db, input, this.origin(), true),
    );
  }
  async inspect(query?: QueueListQuery) {
    return this.retry(() => queueOps.inspect(this.db, query));
  }
  async enroll(input: QueueEnrollCommand) {
    return this.retry(() => queueOps.enroll(this.db, input, this.origin()));
  }
  async edit(id: string, input: QueueEditCommand) {
    return this.retry(() => queueOps.edit(this.db, id, input, this.origin()));
  }
  async withdraw(id: string, input: QueueRevisionCommand) {
    return this.retry(() =>
      queueOps.withdraw(this.db, id, input, this.origin()),
    );
  }
  async claimNext(input: QueueClaimCommand) {
    return this.retry(() => queueOps.claimNext(this.db, input, this.origin()));
  }
}
export class EmbeddedAttemptBackend implements AttemptBackend {
  constructor(
    private db: EmbeddedDb,
    private origin: () => RequestOrigin,
    private retry: Retry,
  ) {}
  async get(id: string) {
    return this.retry(() => attemptOps.view(this.db, id, this.origin()));
  }
  async list(query?: Parameters<typeof attemptOps.list>[1]) {
    return this.retry(() => attemptOps.list(this.db, query));
  }
  async accept(id: string, input: AttemptAuthorityCommand) {
    return this.retry(() =>
      attemptOps.accept(this.db, id, input, this.origin()),
    );
  }
  async started(id: string, input: AttemptStartedCommand) {
    return this.retry(() =>
      attemptOps.started(this.db, id, input, this.origin()),
    );
  }
  async heartbeat(id: string, input: AttemptAuthorityCommand) {
    return this.retry(() =>
      attemptOps.heartbeat(this.db, id, input, this.origin()),
    );
  }
  async finish(id: string, input: AttemptFinishCommand) {
    return this.retry(() =>
      attemptOps.finish(this.db, id, input, this.origin()),
    );
  }
}
