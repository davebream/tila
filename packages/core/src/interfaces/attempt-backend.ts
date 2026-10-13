import type {
  AttemptAuthorityCommand,
  AttemptCorrectCommand,
  AttemptFinishCommand,
  AttemptForceCommand,
  AttemptListQuery,
  AttemptRebindCommand,
  AttemptReconcileCommand,
  AttemptReplaceSessionCommand,
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
  list(options?: AttemptListQuery): Promise<WorkAttempt[]>;
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
  /** Link corrective work to a finished attempt without changing its result. */
  correct(id: string, command: AttemptCorrectCommand): Promise<AttemptView>;
  /** Attach a replacement native session to the same attempt; owner only. */
  replaceSession(
    id: string,
    command: AttemptReplaceSessionCommand,
  ): Promise<AttemptView>;
  finish(id: string, command: AttemptFinishCommand): Promise<AttemptView>;
}
