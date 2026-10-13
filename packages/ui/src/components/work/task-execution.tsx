import { EnrollmentForm } from "@/components/queue/controls";
import { revision, useAction } from "@/components/queue/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { FormNotice, TextField } from "@/components/ui/form-fields";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  controlAttempt,
  controlQueue,
  dashboardParticipantId,
  listAttempts,
  listQuestions,
} from "@/lib/api";
import {
  OUTCOME_LABELS,
  activeAttempt,
  attemptStatus,
  evidenceLink,
  latestFinished,
  liveEntry,
  retryable,
} from "@/lib/execution";
import { failureKind, failureMessage } from "@/lib/mutation-errors";
import type { TaskState } from "@/lib/presentation";
import { type Rights, controlsAttempt, editsEnrollment } from "@/lib/rights";
import { formatDateTime, relativeTime } from "@/lib/time";
import { useQuery } from "@tanstack/react-query";
import type {
  QueueEntry,
  QueueInspection,
  WhoamiResponse,
  WorkAttempt,
} from "@tila/schemas";
import { type ReactNode, useRef, useState } from "react";
import { Link } from "react-router";

const PAGE = 20;
const linkClass =
  "rounded-sm text-signal-blue underline decoration-signal-blue/40 underline-offset-2 hover:text-signal-blue-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal-blue";

/** Plain text for ConfirmAction's alert (it renders its own `role="alert"`). */
function errorText(error: unknown): string | undefined {
  if (!error) return undefined;
  return failureKind(error) === "conflict"
    ? `${failureMessage(error)} It changed since this page loaded; review the latest state before trying again.`
    : failureMessage(error);
}

function shortId(id: string) {
  return id.length > 12 ? `${id.slice(0, 8)}…` : id;
}

function Evidence({ value, project }: { value: string; project: string }) {
  const link = evidenceLink(value);
  if (link.kind === "artifact")
    return (
      <Link className={linkClass} to={`/p/${project}/artifacts/${link.key}`}>
        Artifact {link.label}
      </Link>
    );
  if (link.kind === "text")
    return <span className="break-all font-mono text-xs">{link.label}</span>;
  return (
    <a
      className={`${linkClass} break-all`}
      href={link.href}
      rel="noreferrer"
      target="_blank"
    >
      {link.label}
    </a>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words text-foreground">{children}</dd>
    </>
  );
}

/** Open questions an attempt-ending action would supersede, read live. */
function OpenQuestionsPreview({
  project,
  attemptId,
  enabled,
}: {
  project: string;
  attemptId: string;
  enabled: boolean;
}) {
  const query = useQuery({
    queryKey: ["questions", project, { attempt_id: attemptId, state: "open" }],
    queryFn: () =>
      listQuestions(project, { attempt_id: attemptId, state: "open" }),
    enabled,
  });
  if (query.isPending) return <p>Checking open questions on this attempt…</p>;
  if (query.isError)
    return (
      <p>
        Open questions could not be checked. Any open question on this attempt
        is superseded when the attempt finishes.
      </p>
    );
  const count = query.data.questions.length;
  return (
    <p>
      {count === 0
        ? "No open questions on this attempt."
        : `${count} open question${count === 1 ? "" : "s"} on this attempt will be superseded when it finishes, and can no longer be answered.`}
    </p>
  );
}

function CancelAction({
  project,
  attempt,
  disabled,
}: {
  project: string;
  attempt: WorkAttempt;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  // One command per confirmation, so a retried click is answered by the receipt.
  const command = useRef(revision(attempt.revision));
  const action = useAction(project, () =>
    controlAttempt(project, {
      action: "request-cancellation",
      id: attempt.id,
      command: command.current,
    }),
  );
  return (
    <>
      <Button
        size="sm"
        variant="outline"
        disabled={disabled || attempt.cancellation_requested}
        onClick={() => {
          command.current = revision(attempt.revision);
          action.reset();
          setOpen(true);
        }}
      >
        {attempt.cancellation_requested
          ? "Cancellation requested"
          : "Request cancellation"}
      </Button>
      <ConfirmAction
        open={open}
        onOpenChange={setOpen}
        title="Request cancellation"
        confirmLabel="Request cancellation"
        pending={action.isPending}
        error={errorText(action.error)}
        onConfirm={() =>
          action.mutate(undefined, { onSuccess: () => setOpen(false) })
        }
        description={
          <div className="space-y-2">
            <p>
              This records a request on attempt{" "}
              <span className="font-mono">{shortId(attempt.id)}</span>. It does
              not stop the process. The worker's runtime has to confirm the
              stop, and only then does the attempt record a result.
            </p>
            <OpenQuestionsPreview
              project={project}
              attemptId={attempt.id}
              enabled={open}
            />
          </div>
        }
      />
    </>
  );
}

function RetryAction({
  project,
  attempt,
  disabled,
}: {
  project: string;
  attempt: WorkAttempt;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [missing, setMissing] = useState(false);
  // The whole command is frozen per reason: a retried confirmation resends
  // exactly what was sent, even if the attempt was refetched in between.
  const command = useRef<{
    body: string;
    sent: {
      expected_revision: number;
      idempotency_key: string;
      reason: string;
    };
  } | null>(null);
  const action = useAction(
    project,
    (sent: {
      expected_revision: number;
      idempotency_key: string;
      reason: string;
    }) =>
      controlAttempt(project, {
        action: "retry",
        id: attempt.id,
        command: sent,
      }),
  );
  const outcome = attempt.outcome?.status ?? "failure";
  return (
    <>
      <Button
        size="sm"
        variant="outline"
        disabled={disabled}
        onClick={() => {
          action.reset();
          setMissing(false);
          setOpen(true);
        }}
      >
        Retry
      </Button>
      <ConfirmAction
        open={open}
        onOpenChange={setOpen}
        title="Retry this work"
        confirmLabel="Start a new attempt"
        pending={action.isPending}
        error={
          missing ? "Enter a reason for the retry." : errorText(action.error)
        }
        onConfirm={() => {
          const body = reason.trim();
          setMissing(!body);
          if (!body) return;
          // Same reason, same command: a retried confirmation is not a second retry.
          if (command.current?.body !== body)
            command.current = {
              body,
              sent: {
                expected_revision: attempt.revision,
                idempotency_key: crypto.randomUUID(),
                reason: body,
              },
            };
          action.mutate(command.current.sent, {
            onSuccess: () => setOpen(false),
          });
        }}
        description={
          <div className="space-y-3">
            <p>
              Starts a new attempt for this task. Attempt{" "}
              <span className="font-mono">{shortId(attempt.id)}</span> keeps its{" "}
              {OUTCOME_LABELS[outcome].toLowerCase()} result and evidence.
            </p>
            <TextField
              label="Reason"
              required
              value={reason}
              maxLength={2000}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
        }
      />
    </>
  );
}

function ReassignAction({
  project,
  entry,
  active,
}: {
  project: string;
  entry: QueueEntry;
  active: WorkAttempt | null;
}) {
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState(entry.target_principal ?? "");
  // Frozen per dialog and per assignee: resending the same choice reuses its
  // command; choosing someone else is a new request.
  const command = useRef(revision(entry.revision));
  const sent = useRef<{ target: string | null; key: string } | null>(null);
  const action = useAction(project, (next: string | null) => {
    if (!sent.current || sent.current.target !== next)
      sent.current = {
        target: next,
        key: sent.current
          ? crypto.randomUUID()
          : command.current.idempotency_key,
      };
    return controlQueue(project, {
      action: "edit",
      id: entry.id,
      command: {
        expected_revision: command.current.expected_revision,
        idempotency_key: sent.current.key,
        target_principal: next,
      },
    });
  });
  return (
    <>
      <Button
        size="sm"
        variant="outline"
        onClick={() => {
          command.current = revision(entry.revision);
          sent.current = null;
          setTarget(entry.target_principal ?? "");
          action.reset();
          setOpen(true);
        }}
      >
        Change assignee
      </Button>
      <ConfirmAction
        open={open}
        onOpenChange={setOpen}
        title="Change assignee"
        confirmLabel="Save assignee"
        pending={action.isPending}
        error={errorText(action.error)}
        onConfirm={() =>
          action.mutate(target.trim() || null, {
            onSuccess: () => setOpen(false),
          })
        }
        description={
          <div className="space-y-3">
            <p>
              The assignee decides which principal may take the next attempt.
              Leave it empty to let any eligible worker take it.
            </p>
            {active && (
              <p>
                Attempt <span className="font-mono">{shortId(active.id)}</span>{" "}
                keeps its current owner. To hand the work over now, request its
                cancellation, or ask a maintainer to rebind it from the attempt
                details.
              </p>
            )}
            <TextField
              label="Assignee principal"
              className="font-mono"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
            />
          </div>
        }
      />
    </>
  );
}

interface TaskExecutionProps {
  project: string;
  taskId: string;
  /** The task's own lifecycle value, shown apart from attempt state. */
  state: TaskState | null;
  queue: {
    data?: QueueInspection;
    isError: boolean;
  };
  identity?: WhoamiResponse;
  allowed: Rights;
  canFollowUp: boolean;
  attemptLink: (id: string) => string;
  followUpLink: (attemptId: string) => string;
}

/**
 * Who holds the work, what it is doing, and what it produced. The task's
 * lifecycle value, the current attempt and the recorded result stay apart:
 * a cancellation request is not a stopped process, and neither is a result.
 */
export function TaskExecution({
  project,
  taskId,
  state,
  queue,
  identity,
  allowed,
  canFollowUp,
  attemptLink,
  followUpLink,
}: TaskExecutionProps) {
  const [limit, setLimit] = useState(PAGE);
  const attempts = useQuery({
    queryKey: ["queue", project, "attempts", taskId, limit],
    queryFn: () => listAttempts(project, { task_id: taskId, limit }),
    enabled: Boolean(project && taskId),
    refetchInterval: 5_000,
    placeholderData: (previous) => previous,
  });
  const questions = useQuery({
    queryKey: ["questions", project, { task_id: taskId, state: "open" }],
    queryFn: () => listQuestions(project, { task_id: taskId, state: "open" }),
    enabled: Boolean(project && taskId),
    refetchInterval: 10_000,
  });

  const rows = attempts.data ?? [];
  const active = activeAttempt(rows);
  const finished = latestFinished(rows);
  const entry = liveEntry(
    (queue.data?.entries ?? []).map((view) => view.entry),
    taskId,
  );
  const fresh = !attempts.isError && attempts.fetchStatus !== "paused";
  const participant = dashboardParticipantId();
  const controls = (attempt: WorkAttempt) =>
    controlsAttempt(
      identity,
      allowed,
      attempt,
      entry ? entry.enrolled_by_principal : undefined,
      participant,
    );

  if (attempts.isPending)
    return <p className="text-sm text-muted-foreground">Loading attempts…</p>;
  if (attempts.isError && !attempts.data)
    return (
      <FormNotice>
        Attempts could not be loaded. Execution state is unknown, so no actions
        are offered.{" "}
        <Button
          size="xs"
          variant="outline"
          onClick={() => void attempts.refetch()}
        >
          Retry
        </Button>
      </FormNotice>
    );

  const openQuestions = questions.data?.questions ?? [];
  return (
    <div className="space-y-5">
      {attempts.isError && (
        <FormNotice tone="warning">
          Showing the last loaded attempts; refreshing failed. Actions are
          paused until it succeeds.
        </FormNotice>
      )}
      <dl className="grid grid-cols-[minmax(7rem,auto)_1fr] gap-x-4 gap-y-2 text-sm">
        <Row label="Task state">
          {/* One text node: the header badge already shows the bare value. */}
          {state ? (
            `${state.value} (the task's own lifecycle value)`
          ) : (
            <span className="text-muted-foreground">Not set</span>
          )}
        </Row>
        <Row label="Attempt">
          {active ? (
            <>
              <Link className={linkClass} to={attemptLink(active.id)}>
                <span className="font-mono">{shortId(active.id)}</span>
              </Link>{" "}
              {attemptStatus(active)}
            </>
          ) : entry ? (
            entry.state === "queued" ? (
              "Queued, waiting for a worker"
            ) : (
              "Admitted, no attempt running"
            )
          ) : queue.isError ? (
            "No attempt running · queue status unavailable"
          ) : (
            "No attempt running · not in the queue"
          )}
        </Row>
        <Row label="Result">
          {finished?.outcome ? (
            <>
              <Badge
                variant={
                  finished.outcome.status === "success" ? "green" : "red"
                }
              >
                {OUTCOME_LABELS[finished.outcome.status]}
              </Badge>{" "}
              recorded by attempt{" "}
              <Link className={linkClass} to={attemptLink(finished.id)}>
                <span className="font-mono">{shortId(finished.id)}</span>
              </Link>
              {finished.finished_at !== null && (
                <span
                  className="text-muted-foreground"
                  title={formatDateTime(finished.finished_at)}
                >
                  {" "}
                  · {relativeTime(finished.finished_at)}
                </span>
              )}
              {finished.outcome.reason && (
                <p className="mt-1 text-muted-foreground">
                  {finished.outcome.reason}
                </p>
              )}
            </>
          ) : (
            <span className="text-muted-foreground">
              No result recorded yet
            </span>
          )}
        </Row>
        <Row label="Responsible">
          {active ? (
            <span className="break-all font-mono text-xs">
              {active.principal_id} · {active.participant_id}
            </span>
          ) : entry?.target_principal ? (
            <span className="break-all font-mono text-xs">
              {entry.target_principal} (next attempt)
            </span>
          ) : entry ? (
            "Any eligible worker"
          ) : (
            <span className="text-muted-foreground">Nobody</span>
          )}
        </Row>
        {entry && (
          <Row label="Assigned by">
            <span className="break-all font-mono text-xs">
              {entry.enrolled_by_principal ?? "Not recorded"}
            </span>
          </Row>
        )}
      </dl>
      <p className="text-xs text-muted-foreground">
        Only an attempt's recorded result counts as the result. Reports,
        messages and acknowledgements in History are claims, not results.
      </p>

      {finished?.outcome && finished.outcome.evidence.length > 0 && (
        <div className="space-y-1">
          <h3 className="tila-label">Evidence</h3>
          <ul className="space-y-1 text-sm">
            {finished.outcome.evidence.map((value) => (
              <li key={value}>
                <Evidence value={value} project={project} />
              </li>
            ))}
          </ul>
        </div>
      )}

      {openQuestions.length > 0 && (
        <div className="space-y-1">
          <h3 className="tila-label">
            Open questions ({openQuestions.length})
          </h3>
          <ul className="space-y-1 text-sm">
            {openQuestions.map(({ question }) => (
              <li key={question.id}>
                <Link
                  className={`${linkClass} line-clamp-2`}
                  to={`/p/${project}/decisions/${question.id}`}
                >
                  {question.text}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {active && controls(active) && (
          <CancelAction project={project} attempt={active} disabled={!fresh} />
        )}
        {!active && finished && retryable(finished) && controls(finished) && (
          <RetryAction project={project} attempt={finished} disabled={!fresh} />
        )}
        {entry &&
          editsEnrollment(identity, allowed, entry.enrolled_by_principal) && (
            <ReassignAction project={project} entry={entry} active={active} />
          )}
        {finished && canFollowUp && (
          <Button asChild size="sm" variant="outline">
            <Link to={followUpLink(finished.id)}>Create follow-up task</Link>
          </Button>
        )}
        <Button asChild size="sm" variant="ghost">
          <Link to={`/p/${project}/runtime`}>Runtime</Link>
        </Button>
      </div>
      {active && allowed.operate && !controls(active) && (
        <p className="text-xs text-muted-foreground">
          Only the attempt owner, the principal that enrolled this work, or a
          maintainer can request changes or retry.
        </p>
      )}

      {/* After a success, corrective work is a follow-up task, not a rerun. */}
      {!entry &&
        !active &&
        !queue.isError &&
        finished?.outcome?.status !== "success" && (
          <EnrollmentForm
            project={project}
            task={taskId}
            allowed={allowed.edit}
          />
        )}

      {rows.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-border">
          <Table aria-label="Attempt history">
            <TableHeader>
              <TableRow>
                <TableHead>Attempt</TableHead>
                <TableHead>State</TableHead>
                <TableHead>Owner</TableHead>
                <TableHead>Result</TableHead>
                <TableHead className="text-right">Started</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((attempt) => (
                <TableRow key={attempt.id}>
                  <TableCell>
                    <Link className={linkClass} to={attemptLink(attempt.id)}>
                      <span className="font-mono">{shortId(attempt.id)}</span>
                    </Link>
                  </TableCell>
                  <TableCell className="text-foreground">
                    {attempt.state}
                    {attempt.cancellation_requested &&
                      attempt.state !== "terminal" &&
                      " · cancel requested"}
                  </TableCell>
                  <TableCell className="break-all font-mono text-xs">
                    {attempt.principal_id}
                  </TableCell>
                  <TableCell>
                    {attempt.outcome
                      ? OUTCOME_LABELS[attempt.outcome.status]
                      : "—"}
                  </TableCell>
                  <TableCell
                    className="tila-num text-right text-muted-foreground"
                    title={formatDateTime(attempt.created_at)}
                  >
                    {relativeTime(attempt.created_at)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {rows.length >= limit && (
        <Button
          size="sm"
          variant="ghost"
          disabled={attempts.isFetching}
          onClick={() => setLimit(limit + PAGE)}
        >
          Show older attempts
        </Button>
      )}
    </div>
  );
}
