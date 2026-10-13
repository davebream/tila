import type { AttemptBackend, QueueBackend } from "@tila/core";
import {
  type AttemptAuthorityCommand,
  type AttemptCorrectCommand,
  type AttemptFinishCommand,
  type AttemptForceCommand,
  type AttemptListQuery,
  type AttemptRebindCommand,
  type AttemptReconcileCommand,
  type AttemptReplaceSessionCommand,
  type AttemptResumeCommand,
  AttemptResumeResultSchema,
  type AttemptRetryCommand,
  type AttemptStartedCommand,
  type AttemptSuspendCommand,
  AttemptViewSchema,
  type QueueClaimCommand,
  QueueClaimResultSchema,
  type QueueConfigureCommand,
  type QueueEditCommand,
  type QueueEnrollCommand,
  QueueEntrySchema,
  QueueInspectionSchema,
  type QueueListQuery,
  QueuePolicySchema,
  type QueueRevisionCommand,
  WorkAttemptSchema,
} from "@tila/schemas";
import type { z } from "zod";
import type { TilaClient } from "../client";

function query(input: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(input)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [
        key,
        Array.isArray(value) ? JSON.stringify(value) : String(value),
      ]),
  );
}
export class RemoteQueueBackend implements QueueBackend {
  private base: string;
  constructor(
    private client: TilaClient,
    projectId: string,
  ) {
    this.base = `/projects/${encodeURIComponent(projectId)}/queue`;
  }
  private async mutate<T>(
    path: string,
    input: { idempotency_key: string },
    schema: z.ZodType<T>,
  ): Promise<T> {
    const response = await this.client.post<{ result: unknown }>(
      `${this.base}/${path}`,
      input,
      { idempotencyKey: input.idempotency_key },
    );
    return schema.parse(response.result);
  }
  async policy() {
    return QueuePolicySchema.parse(
      (await this.client.get<{ result: unknown }>(`${this.base}/policy`))
        .result,
    );
  }
  async inspect(input: QueueListQuery = {}) {
    return QueueInspectionSchema.parse(
      (
        await this.client.get<{ result: unknown }>(this.base, {
          query: query(input),
        })
      ).result,
    );
  }
  configure(input: QueueConfigureCommand) {
    return this.mutate("configure", input, QueuePolicySchema);
  }
  enroll(input: QueueEnrollCommand) {
    return this.mutate("enroll", input, QueueEntrySchema);
  }
  edit(id: string, input: QueueEditCommand) {
    return this.mutate(
      `entries/${encodeURIComponent(id)}/edit`,
      input,
      QueueEntrySchema,
    );
  }
  withdraw(id: string, input: QueueRevisionCommand) {
    return this.mutate(
      `entries/${encodeURIComponent(id)}/withdraw`,
      input,
      QueueEntrySchema,
    );
  }
  claimNext(input: QueueClaimCommand) {
    return this.mutate("claim", input, QueueClaimResultSchema);
  }
}
export class RemoteAttemptBackend implements AttemptBackend {
  private base: string;
  constructor(
    private client: TilaClient,
    projectId: string,
  ) {
    this.base = `/projects/${encodeURIComponent(projectId)}/attempts`;
  }
  private async mutate<T>(
    id: string,
    action: string,
    input: { idempotency_key: string },
    schema: z.ZodType<T>,
  ): Promise<T> {
    const response = await this.client.post<{ result: unknown }>(
      `${this.base}/${encodeURIComponent(id)}/${action}`,
      input,
      { idempotencyKey: input.idempotency_key },
    );
    return schema.parse(response.result);
  }
  async get(id: string) {
    return AttemptViewSchema.parse(
      (
        await this.client.get<{ result: unknown }>(
          `${this.base}/${encodeURIComponent(id)}`,
        )
      ).result,
    );
  }
  async list(input: AttemptListQuery = {}) {
    return WorkAttemptSchema.array().parse(
      (
        await this.client.get<{ result: unknown }>(this.base, {
          query: query(input),
        })
      ).result,
    );
  }
  accept(id: string, input: AttemptAuthorityCommand) {
    return this.mutate(id, "accept", input, AttemptViewSchema);
  }
  started(id: string, input: AttemptStartedCommand) {
    return this.mutate(id, "started", input, AttemptViewSchema);
  }
  heartbeat(id: string, input: AttemptAuthorityCommand) {
    return this.mutate(id, "heartbeat", input, AttemptViewSchema);
  }
  finish(id: string, input: AttemptFinishCommand) {
    return this.mutate(id, "finish", input, AttemptViewSchema);
  }
  requestCancellation(id: string, input: QueueRevisionCommand) {
    return this.mutate(id, "request-cancellation", input, AttemptViewSchema);
  }
  requestSuspension(id: string, input: QueueRevisionCommand) {
    return this.mutate(id, "request-suspension", input, AttemptViewSchema);
  }
  confirmSuspension(id: string, input: AttemptSuspendCommand) {
    return this.mutate(id, "confirm-suspension", input, AttemptViewSchema);
  }
  requestResume(id: string, input: QueueRevisionCommand) {
    return this.mutate(id, "request-resume", input, AttemptViewSchema);
  }
  claimResume(id: string, input: AttemptResumeCommand) {
    return this.mutate(id, "claim-resume", input, AttemptResumeResultSchema);
  }
  reconcile(id: string, input: AttemptReconcileCommand) {
    return this.mutate(id, "reconcile", input, AttemptViewSchema);
  }
  rebind(id: string, input: AttemptRebindCommand) {
    return this.mutate(id, "rebind", input, AttemptViewSchema);
  }
  retry(id: string, input: AttemptRetryCommand) {
    return this.mutate(id, "retry", input, AttemptViewSchema);
  }
  forceRecovery(id: string, input: AttemptForceCommand) {
    return this.mutate(id, "force-recovery", input, AttemptViewSchema);
  }
  correct(id: string, input: AttemptCorrectCommand) {
    return this.mutate(id, "correct", input, AttemptViewSchema);
  }
  replaceSession(id: string, input: AttemptReplaceSessionCommand) {
    return this.mutate(id, "replace-session", input, AttemptViewSchema);
  }
}
