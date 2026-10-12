import type { AttemptBackend, QueueBackend } from "@tila/core";
import type {
  AttemptOutcome,
  AttemptSession,
  AttemptView,
  QueueClaimCommand,
  WorkAttempt,
} from "@tila/schemas";
import { TilaApiError } from "./errors";

/** `absent` proves this attempt has never launched; a missing response is unknown. */
export type ExecutionObservation =
  | { state: "absent" }
  | { state: "unknown"; reason: string }
  | { state: "running"; session: AttemptSession }
  | {
      state: "suspended";
      session: AttemptSession;
      checkpoint: Record<string, unknown>;
    }
  | { state: "stopped"; outcome: AttemptOutcome };

export interface ExecutionContext {
  /** Stop initiating external effects when aborted. Existing effects cannot be retracted. */
  signal: AbortSignal;
}

/**
 * Runtime operations must durably deduplicate by attempt ID. Persist the launch
 * intent and session association before acknowledging start. Inspection must
 * survive wrapper restarts and distinguish unknown from proven absence.
 */
export interface QueueExecutionAdapter {
  inspect(attempt: WorkAttempt): Promise<ExecutionObservation>;
  start(attempt: WorkAttempt, context: ExecutionContext): Promise<void>;
  cancel(attempt: WorkAttempt, context: ExecutionContext): Promise<void>;
  suspend?(attempt: WorkAttempt, context: ExecutionContext): Promise<void>;
  resume?(attempt: WorkAttempt, context: ExecutionContext): Promise<void>;
}

export interface QueueExecutorOptions {
  principalId: string;
  participantId: string;
  capabilities?: string[];
  /** Defaults to 20 seconds; shortened automatically for shorter leases. */
  heartbeatIntervalMs?: number;
}

export class QueueAuthorityLostError extends Error {
  constructor(
    message = "Execution authority was lost; inspect and reconcile before acting",
  ) {
    super(message);
    this.name = "QueueAuthorityLostError";
  }
}

/** A repository wrapper's execution loop. Scheduling and retries stay in Tila. */
export class QueueExecutor {
  private busy = new Set<string>();
  constructor(
    private backend: { queue: QueueBackend; attempts: AttemptBackend },
    private adapter: QueueExecutionAdapter,
    private options: QueueExecutorOptions,
  ) {
    if (!!adapter.suspend !== !!adapter.resume)
      throw new Error(
        "An adapter must implement both suspend and resume, or neither",
      );
    if ((options.heartbeatIntervalMs ?? 20_000) <= 0)
      throw new Error("Heartbeat interval must be positive");
  }

  /** Save/reuse the command key if the claim response is lost. No spawn happens here. */
  claim(command: QueueClaimCommand) {
    return this.backend.queue.claimNext({
      capabilities: this.options.capabilities ?? [],
      ...command,
    });
  }

  /** Find this wrapper's existing work before claiming more after a restart. */
  async recoverable(): Promise<WorkAttempt[]> {
    const result: WorkAttempt[] = [];
    for (let offset = 0; ; offset += 100) {
      const page = await this.backend.attempts.list({ limit: 100, offset });
      result.push(
        ...page.filter((a) => a.state !== "terminal" && this.owned(a)),
      );
      if (page.length < 100) return result;
    }
  }

  private owned(attempt: WorkAttempt) {
    return (
      attempt.principal_id === this.options.principalId &&
      attempt.participant_id === this.options.participantId
    );
  }

  private revision(view: AttemptView) {
    return {
      expected_revision: view.attempt.revision,
      idempotency_key: crypto.randomUUID(),
    };
  }
  private authority(view: AttemptView) {
    if (!this.owned(view.attempt) || !view.grant_valid)
      throw new QueueAuthorityLostError();
    return { ...this.revision(view), fence: view.attempt.fence };
  }

  /** Retry an ambiguous transport response with the exact same command and receipt key. */
  private async command<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof TilaApiError && error.status < 500) throw error;
      return operation();
    }
  }

  /** One poll, including heartbeats while a runtime operation is in flight. */
  async step(id: string, signal?: AbortSignal): Promise<AttemptView> {
    if (this.busy.has(id))
      throw new Error("This executor is already processing the attempt");
    this.busy.add(id);
    try {
      return await this.advance(id, signal);
    } finally {
      this.busy.delete(id);
    }
  }

  private async advance(
    id: string,
    signal?: AbortSignal,
  ): Promise<AttemptView> {
    signal?.throwIfAborted();
    let view = await this.backend.attempts.get(id);
    if (!this.owned(view.attempt))
      throw new QueueAuthorityLostError("Attempt belongs to another worker");
    if (view.attempt.state === "terminal") return view;
    if (view.attempt.state === "reserved") {
      if (view.attempt.cancellation_requested) {
        const input = {
          ...this.authority(view),
          outcome: {
            status: "cancelled" as const,
            reason: "Cancelled before execution was authorized",
            execution_stopped: true,
            unresolved_external_execution: false,
            evidence: [],
          },
        };
        return this.command(() => this.backend.attempts.finish(id, input));
      }
      const input = this.authority(view);
      view = await this.command(() => this.backend.attempts.accept(id, input));
    }
    if (view.attempt.state === "resume_pending") {
      if (!this.adapter.resume) return view;
      const input = {
        ...this.revision(view),
        capabilities: this.options.capabilities ?? [],
      };
      const result = await this.command(() =>
        this.backend.attempts.claimResume(id, input),
      );
      if (result.kind === "no_grant") return result;
      view = result;
    }

    const observed = await this.adapter.inspect(view.attempt);
    if (
      view.attempt.session &&
      "session" in observed &&
      (["provider", "id", "host_id", "worktree", "url"] as const).some(
        (field) => view.attempt.session?.[field] !== observed.session[field],
      )
    ) {
      throw new QueueAuthorityLostError(
        "Inspected session differs from the recorded execution; reconciliation is required",
      );
    }
    // Reading execution is always safe. Reconciliation never invents a replacement.
    if (observed.state === "stopped" || view.attempt.state === "uncertain") {
      if (observed.state === "absent" || observed.state === "unknown")
        return view;
      const input = {
        ...this.revision(view),
        reason: "Repository adapter inspected the durable execution record",
        ...(observed.state === "stopped"
          ? { observation: "stopped" as const, outcome: observed.outcome }
          : observed.state === "suspended"
            ? {
                observation: "suspended" as const,
                execution_quiescent: true as const,
                session: observed.session,
                checkpoint: observed.checkpoint,
              }
            : { observation: "running" as const, session: observed.session }),
      };
      return this.command(() => this.backend.attempts.reconcile(id, input));
    }
    if (view.attempt.state === "suspended") {
      // A suspended task retains ownership, but no execution lease. Cancellation
      // may dispose of its checkpoint; it must never resume execution to do so.
      if (
        view.attempt.cancellation_requested &&
        observed.state === "suspended"
      ) {
        const input = {
          ...this.revision(view),
          observation: "suspended" as const,
          reason:
            "Verify retained ownership before disposing of a suspended execution",
          execution_quiescent: true as const,
          session: observed.session,
          checkpoint: observed.checkpoint,
        };
        view = await this.command(() =>
          this.backend.attempts.reconcile(id, input),
        );
        signal?.throwIfAborted();
        await this.adapter.cancel(view.attempt, {
          signal: signal ?? new AbortController().signal,
        });
      }
      return view;
    }
    if (observed.state === "unknown") {
      const input = {
        ...this.revision(view),
        observation: "unknown" as const,
        reason: observed.reason,
      };
      return this.command(() => this.backend.attempts.reconcile(id, input));
    }

    // Renew immediately before external work. Never adopt a replacement fence
    // discovered while an old call is still in flight.
    const fence = view.attempt.fence;
    const renew = async () => {
      for (let retry = 0; ; retry++) {
        const fresh = await this.backend.attempts.get(id);
        if (fresh.attempt.fence !== fence) throw new QueueAuthorityLostError();
        const input = this.authority(fresh);
        let renewed: AttemptView;
        try {
          renewed = await this.command(() =>
            this.backend.attempts.heartbeat(id, input),
          );
        } catch (error) {
          if (
            retry < 2 &&
            error instanceof TilaApiError &&
            error.code === "queue-precondition"
          )
            continue;
          throw error;
        }
        if (!renewed.grant_valid || renewed.attempt.fence !== fence)
          throw new QueueAuthorityLostError();
        view = renewed;
        return;
      }
    };
    await renew();
    if (
      observed.state === "absent" &&
      view.attempt.cancellation_requested &&
      !view.attempt.session &&
      !view.attempt.checkpoint
    ) {
      const input = {
        ...this.authority(view),
        outcome: {
          status: "cancelled" as const,
          reason: "Cancellation acknowledged before launch",
          evidence: [],
          execution_stopped: true,
          unresolved_external_execution: false,
        },
      };
      return this.command(() => this.backend.attempts.finish(id, input));
    }
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pending: Promise<void> = Promise.resolve();
    let ended = false;
    let failure: unknown;
    const schedule = () => {
      const remaining =
        (view.attempt.lease_expires_at ?? Date.now()) - Date.now();
      timer = setTimeout(
        () => {
          pending = renew()
            .then(() => {
              if (!ended) schedule();
            })
            .catch((error) => {
              failure = error;
              controller.abort(error);
            });
        },
        Math.max(
          1,
          Math.min(this.options.heartbeatIntervalMs ?? 20_000, remaining / 3),
        ),
      );
    };
    schedule();
    let actionError: unknown;
    try {
      controller.signal.throwIfAborted();
      if (view.attempt.cancellation_requested) {
        await this.adapter.cancel(view.attempt, { signal: controller.signal });
      } else if (observed.state === "absent") {
        if (
          view.attempt.session ||
          view.attempt.checkpoint ||
          view.attempt.state !== "starting"
        )
          throw new Error("An existing execution cannot be replaced by start");
        await this.adapter.start(view.attempt, { signal: controller.signal });
      } else if (
        observed.state === "suspended" &&
        view.attempt.state === "starting"
      ) {
        if (!this.adapter.resume) return view;
        await this.adapter.resume(view.attempt, { signal: controller.signal });
      } else if (view.attempt.suspension_requested && this.adapter.suspend) {
        await this.adapter.suspend(view.attempt, { signal: controller.signal });
      }
    } catch (error) {
      actionError = error;
    } finally {
      ended = true;
      clearTimeout(timer);
      await pending;
      signal?.removeEventListener("abort", abort);
    }
    if (failure) throw failure;
    signal?.throwIfAborted();
    // A thrown runtime call may already have launched/stopped execution. Inspect
    // instead of calling start again. Durable records are the adapter's contract.
    const result = await this.adapter.inspect(view.attempt);
    const current = await this.backend.attempts.get(id);
    if (current.attempt.fence !== fence || !current.grant_valid)
      throw new QueueAuthorityLostError();
    view = current;
    if (result.state === "stopped") {
      const input = { ...this.authority(view), outcome: result.outcome };
      return this.command(() => this.backend.attempts.finish(id, input));
    }
    if (result.state === "running" && view.attempt.state === "starting") {
      const input = { ...this.authority(view), session: result.session };
      return this.command(() => this.backend.attempts.started(id, input));
    }
    if (
      result.state === "suspended" &&
      view.attempt.suspension_requested &&
      !view.attempt.cancellation_requested
    ) {
      const input = {
        ...this.authority(view),
        execution_quiescent: true as const,
        checkpoint: result.checkpoint,
      };
      return this.command(() =>
        this.backend.attempts.confirmSuspension(id, input),
      );
    }
    if (result.state === "unknown" || result.state === "absent") {
      const input = {
        ...this.revision(view),
        observation: "unknown" as const,
        reason:
          result.state === "unknown"
            ? result.reason
            : "Adapter did not establish a durable execution after the operation",
      };
      return this.command(() => this.backend.attempts.reconcile(id, input));
    }
    if (actionError) throw actionError;
    return view;
  }
}
