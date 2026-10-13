import type { QueueEntry, WorkAttempt } from "@tila/schemas";

/**
 * How a task's execution reads from its attempts. Three things stay separate
 * on purpose: the task's lifecycle value, the state of the current attempt,
 * and the result an attempt recorded. A click, a report or a delivery
 * acknowledgement is never shown as a result.
 */

/** The attempt that currently holds the work, if any (at most one). */
export function activeAttempt(
  attempts: readonly WorkAttempt[],
): WorkAttempt | null {
  return attempts.find((a) => a.state !== "terminal") ?? null;
}

/** The most recently finished attempt; its outcome is the latest result. */
export function latestFinished(
  attempts: readonly WorkAttempt[],
): WorkAttempt | null {
  return (
    [...attempts]
      .filter((a) => a.state === "terminal" && a.outcome)
      .sort((a, b) => (b.finished_at ?? 0) - (a.finished_at ?? 0))[0] ?? null
  );
}

/** Enrollment that still controls the task (queued or admitted). */
export function liveEntry(
  entries: readonly QueueEntry[],
  taskId: string,
): QueueEntry | null {
  return (
    entries.find(
      (e) =>
        e.task_id === taskId &&
        (e.state === "queued" || e.state === "admitted"),
    ) ?? null
  );
}

const STATE_LABELS: Record<WorkAttempt["state"], string> = {
  reserved: "Reserved, waiting for the worker to accept",
  starting: "Accepted, starting",
  running: "Running",
  suspended: "Suspended",
  resume_pending: "Resume requested",
  uncertain: "Lease lapsed, execution unconfirmed",
  terminal: "Finished",
};

/** Plain description of an attempt's execution state and pending requests. */
export function attemptStatus(attempt: WorkAttempt): string {
  const parts = [STATE_LABELS[attempt.state]];
  if (attempt.state !== "terminal") {
    if (attempt.cancellation_requested)
      parts.push("cancellation requested, stop not yet confirmed");
    if (attempt.suspension_requested)
      parts.push("suspension requested, not yet confirmed");
  } else if (attempt.outcome) {
    parts.push(
      attempt.outcome.execution_stopped
        ? "execution confirmed stopped"
        : "execution stop not confirmed",
    );
    if (attempt.outcome.unresolved_external_execution)
      parts.push("external execution unresolved");
  }
  return parts.join(" · ");
}

export const OUTCOME_LABELS = {
  success: "Succeeded",
  failure: "Failed",
  cancelled: "Cancelled",
  abandoned: "Abandoned",
} as const;

/** Whether an explicit retry is allowed for this finished attempt. */
export function retryable(attempt: WorkAttempt | null): boolean {
  return (
    !!attempt?.outcome &&
    attempt.state === "terminal" &&
    attempt.outcome.execution_stopped &&
    !attempt.outcome.unresolved_external_execution &&
    attempt.outcome.status !== "success"
  );
}

export type EvidenceLink =
  | { kind: "pull"; href: string; label: string }
  | { kind: "url"; href: string; label: string }
  | { kind: "artifact"; key: string; label: string }
  | { kind: "text"; label: string };

/**
 * Evidence strings are free-form. Recognise GitHub pull requests, other
 * http(s) links and `artifact:<key>` references; show anything else as text.
 */
export function evidenceLink(value: string): EvidenceLink {
  const pull =
    /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)(?:[/?#].*)?$/i.exec(
      value,
    );
  if (pull)
    return {
      kind: "pull",
      href: value,
      label: `PR #${pull[3]} · ${pull[1]}/${pull[2]}`,
    };
  if (/^https?:\/\//i.test(value))
    return { kind: "url", href: value, label: value };
  const artifact = /^artifact:(.+)$/.exec(value);
  if (artifact)
    return { kind: "artifact", key: artifact[1], label: artifact[1] };
  return { kind: "text", label: value };
}
