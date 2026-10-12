import type {
  AttemptAuthorityCommand,
  AttemptFinishCommand,
  AttemptStartedCommand,
  AttemptView,
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
  finish(id: string, command: AttemptFinishCommand): Promise<AttemptView>;
}
