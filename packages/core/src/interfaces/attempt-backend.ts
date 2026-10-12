import type {
  AttemptAuthorityCommand,
  AttemptFinishCommand,
  AttemptForceCommand,
  AttemptRebindCommand,
  AttemptReconcileCommand,
  AttemptResumeCommand,
  AttemptResumeResult,
  AttemptRetryCommand,
  AttemptStartedCommand,
  AttemptSuspendCommand,
  AttemptView,
  QueueRevisionCommand,
  WorkAttempt,
} from "@tila/schemas";

/** Caller identity is supplied by the backend, never by the command payload. */
export interface AttemptBackend {
  get(id: string): Promise<AttemptView>;
  list(options?: {
    task_id?: string;
    entry_id?: string;
    limit?: number;
    offset?: number;
  }): Promise<WorkAttempt[]>;
  accept(id: string, command: AttemptAuthorityCommand): Promise<AttemptView>;
  started(id: string, command: AttemptStartedCommand): Promise<AttemptView>;
  heartbeat(id: string, command: AttemptAuthorityCommand): Promise<AttemptView>;
  requestCancellation(
    id: string,
    command: QueueRevisionCommand,
  ): Promise<AttemptView>;
  requestSuspension(
    id: string,
    command: QueueRevisionCommand,
  ): Promise<AttemptView>;
  confirmSuspension(
    id: string,
    command: AttemptSuspendCommand,
  ): Promise<AttemptView>;
  requestResume(
    id: string,
    command: QueueRevisionCommand,
  ): Promise<AttemptView>;
  claimResume(
    id: string,
    command: AttemptResumeCommand,
  ): Promise<AttemptResumeResult>;
  reconcile(id: string, command: AttemptReconcileCommand): Promise<AttemptView>;
  rebind(id: string, command: AttemptRebindCommand): Promise<AttemptView>;
  retry(id: string, command: AttemptRetryCommand): Promise<AttemptView>;
  forceRecovery(id: string, command: AttemptForceCommand): Promise<AttemptView>;
  finish(id: string, command: AttemptFinishCommand): Promise<AttemptView>;
}
