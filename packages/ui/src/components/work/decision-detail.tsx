import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { CopyButton } from "@/components/ui/copy-button";
import { Drawer } from "@/components/ui/drawer";
import {
  FormNotice,
  SelectField,
  TextAreaField,
  TextField,
} from "@/components/ui/form-fields";
import { useMemberships, useWhoami } from "@/hooks/use-admin";
import { useAdminCapabilities } from "@/hooks/use-admin";
import { getQuestion, questionAction } from "@/lib/api";
import { failureKind, failureMessage } from "@/lib/mutation-errors";
import {
  editOperation,
  operationKey,
  releaseOperation,
  stageOperation,
  useOperationDraft,
} from "@/lib/operation-draft";
import { type Rights, rights } from "@/lib/rights";
import { formatDateTime, relativeTime } from "@/lib/time";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  Question,
  QuestionCancelCommand,
  QuestionEscalateCommand,
  WhoamiResponse,
} from "@tila/schemas";
import { type FormEvent, type ReactNode, useRef, useState } from "react";
import { Link } from "react-router";
import { z } from "zod";

const linkClass =
  "rounded-sm text-signal-blue underline decoration-signal-blue/40 underline-offset-2 hover:text-signal-blue-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal-blue";

export const QUESTION_STATE: Record<
  Question["state"],
  { label: string; variant: "green" | "gray" | "amber" }
> = {
  open: { label: "Waiting for an answer", variant: "amber" },
  answered: { label: "Answered", variant: "green" },
  cancelled: { label: "Cancelled", variant: "gray" },
  superseded: { label: "Superseded", variant: "gray" },
};

/** Who may act on an open question, mirroring the server's rules. */
export function decisionRights(
  question: Question,
  identity: WhoamiResponse | undefined,
  allowed: Rights,
) {
  const me = identity?.principal_id;
  const responder = !!me && me === question.responder_principal_id;
  const open = question.state === "open";
  return {
    responder,
    // Only the designated responder answers; an escalated question also
    // needs that responder to still be an owner.
    answer:
      open &&
      allowed.decide &&
      responder &&
      (!question.escalated || allowed.owner),
    escalate: open && allowed.decide && (responder || allowed.manage),
    cancel: open && allowed.decide && (responder || allowed.manage),
  };
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words text-foreground">{children}</dd>
    </>
  );
}

function correlation(question: Question) {
  return {
    question_id: question.id,
    expected_revision: question.revision,
    attempt_id: question.attempt_id,
    attempt_revision: question.attempt_revision,
    attempt_fence: question.attempt_fence,
  };
}

function conflictText(error: unknown, question: Question): string {
  if (question.state !== "open")
    return `This question is now ${QUESTION_STATE[question.state].label.toLowerCase()}, so it can no longer be answered here. Your draft is kept below.`;
  return `${failureMessage(error)} The question changed since you opened it. Your draft is kept; review the latest version and submit again.`;
}

const AnswerValue = z.object({ text: z.string() });
const AnswerCommand = z.object({
  question_id: z.string(),
  expected_revision: z.number(),
  attempt_id: z.string(),
  attempt_revision: z.number(),
  attempt_fence: z.number(),
  idempotency_key: z.string(),
  text: z.string(),
});

function AnswerForm({
  project,
  question,
  principal,
  enabled,
}: {
  project: string;
  question: Question;
  principal: string;
  enabled: boolean;
}) {
  const client = useQueryClient();
  const { draft, update, discard } = useOperationDraft(
    operationKey("decision-answer", principal, project, question.id),
    () => ({ text: "" }),
    { value: AnswerValue, command: AnswerCommand },
  );
  const [missing, setMissing] = useState(false);
  const send = useMutation({
    mutationFn: (staged: NonNullable<typeof draft.pending>) =>
      questionAction(project, question.id, {
        action: "answer",
        command: staged.command,
      }),
    onSuccess: async () => {
      discard();
      await client.invalidateQueries({ queryKey: ["questions", project] });
    },
    onError: async (error) => {
      const kind = failureKind(error);
      if (kind === "forbidden")
        await client.invalidateQueries({ queryKey: ["whoami", project] });
      if (kind !== "unconfirmed") {
        update(releaseOperation);
        await client.invalidateQueries({ queryKey: ["questions", project] });
      }
    },
  });
  const kind = send.isError ? failureKind(send.error) : null;
  const locked = send.isPending || Boolean(draft.pending);

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (draft.pending) return send.mutate(draft.pending);
    const text = draft.value.text.trim();
    setMissing(!text);
    if (!text) return;
    const next = stageOperation(draft, (_, id) => ({
      ...correlation(question),
      idempotency_key: id,
      text,
    }));
    update(() => next);
    if (next.pending) send.mutate(next.pending);
  }

  return (
    <form className="space-y-3" onSubmit={onSubmit} noValidate>
      <TextAreaField
        label="Your answer"
        required
        rows={5}
        maxLength={16384}
        value={draft.value.text}
        error={missing ? "Write an answer first." : undefined}
        disabled={locked || !enabled}
        hint="Kept in this browser tab until it is sent, even if you close the drawer."
        onChange={(e) =>
          update((d) => editOperation(d, { text: e.target.value }))
        }
      />
      {kind === "unconfirmed" && (
        <FormNotice tone="warning">
          The server did not confirm the answer ({failureMessage(send.error)}).
          Retry sends the same answer, so it is recorded at most once.
        </FormNotice>
      )}
      {kind === "conflict" && (
        <FormNotice>{conflictText(send.error, question)}</FormNotice>
      )}
      {kind === "forbidden" && (
        <FormNotice>
          Your access changed and the answer was refused. Your draft is kept.
        </FormNotice>
      )}
      {kind === "invalid" && (
        <FormNotice>
          {failureMessage(send.error)} Your draft is kept.
        </FormNotice>
      )}
      <div className="flex justify-end gap-2">
        {draft.value.text && !locked && (
          <Button type="button" variant="ghost" size="sm" onClick={discard}>
            Discard draft
          </Button>
        )}
        <Button type="submit" size="sm" disabled={send.isPending || !enabled}>
          {send.isPending
            ? "Sending…"
            : draft.pending
              ? "Retry"
              : "Send answer"}
        </Button>
      </div>
    </form>
  );
}

/**
 * An answer drafted before the question closed (answered elsewhere, cancelled
 * or superseded). It can no longer be sent, but it is not silently lost.
 */
function UnsentAnswer({
  project,
  question,
  principal,
  why,
}: {
  project: string;
  question: Question;
  principal: string;
  /** Why the draft can no longer be sent. */
  why: string;
}) {
  const { draft, discard } = useOperationDraft(
    operationKey("decision-answer", principal, project, question.id),
    () => ({ text: "" }),
    { value: AnswerValue, command: AnswerCommand },
  );
  if (!draft.value.text.trim()) return null;
  return (
    <section aria-label="Your unsent answer" className="space-y-2">
      <h2 className="tila-label">Your unsent answer</h2>
      <FormNotice tone="warning">
        {why} Your draft was not sent; copy it if you still need it.
      </FormNotice>
      <p className="whitespace-pre-wrap rounded-md border border-border p-3 text-sm">
        {draft.value.text}
      </p>
      <div className="flex gap-2">
        <CopyButton value={draft.value.text} />
        <Button type="button" size="sm" variant="ghost" onClick={discard}>
          Discard draft
        </Button>
      </div>
    </section>
  );
}

/**
 * One frozen command per distinct input. Resubmitting the same input resends
 * exactly the first command (key and correlation), even if the question was
 * refetched since, so the server's receipt answers a lost response.
 */
function useFrozenCommand<C>() {
  const ref = useRef<{ body: string; command: C } | null>(null);
  return (body: string, build: (key: string) => C): C => {
    if (ref.current?.body !== body)
      ref.current = { body, command: build(crypto.randomUUID()) };
    return ref.current.command;
  };
}

function EscalateForm({
  project,
  question,
  enabled,
}: {
  project: string;
  question: Question;
  enabled: boolean;
}) {
  const client = useQueryClient();
  const { canManageMemberships } = useAdminCapabilities();
  const members = useMemberships(false);
  const owners = (members.data?.memberships ?? []).filter(
    (m) => m.role === "owner" && m.revoked_at === null,
  );
  const [target, setTarget] = useState("");
  const [reason, setReason] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const freeze = useFrozenCommand<QuestionEscalateCommand>();
  const send = useMutation({
    mutationFn: (input: { target: string; reason: string }) =>
      questionAction(project, question.id, {
        action: "escalate",
        command: freeze(JSON.stringify(input), (key) => ({
          ...correlation(question),
          idempotency_key: key,
          responder_principal_id: input.target,
          reason: input.reason,
        })),
      }),
    onSettled: () =>
      client.invalidateQueries({ queryKey: ["questions", project] }),
    onSuccess: () => {
      setReason("");
      setTarget("");
    },
  });
  return (
    <details className="rounded-lg border border-border p-4">
      <summary className="cursor-pointer text-sm font-medium">
        Escalate to an owner
      </summary>
      <form
        className="mt-3 space-y-3"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          const next = {
            target: target.trim(),
            reason: reason.trim(),
          };
          const problems: Record<string, string> = {};
          if (!next.target) problems.target = "Choose an owner.";
          if (!next.reason) problems.reason = "Explain why it needs an owner.";
          setErrors(problems);
          if (Object.keys(problems).length === 0) send.mutate(next);
        }}
      >
        <p className="text-xs text-muted-foreground">
          The question moves to the chosen owner, who becomes the only person
          who can answer it. The history below keeps every hand-over.
        </p>
        {canManageMemberships && owners.length > 0 ? (
          <SelectField
            label="Owner"
            required
            value={target}
            error={errors.target}
            disabled={!enabled}
            placeholder="Choose…"
            options={owners.map((m) => ({
              value: m.principal_id,
              label: m.display_name
                ? `${m.display_name} (${m.principal_id})`
                : m.principal_id,
            }))}
            onChange={(e) => setTarget(e.target.value)}
          />
        ) : (
          <TextField
            label="Owner principal"
            required
            className="font-mono"
            value={target}
            error={errors.target}
            disabled={!enabled}
            hint="The server checks that this principal is a current owner."
            onChange={(e) => setTarget(e.target.value)}
          />
        )}
        <TextAreaField
          label="Reason"
          required
          rows={2}
          value={reason}
          error={errors.reason}
          disabled={!enabled}
          onChange={(e) => setReason(e.target.value)}
        />
        {send.isError && (
          <FormNotice>
            {failureKind(send.error) === "conflict"
              ? conflictText(send.error, question)
              : failureMessage(send.error)}
          </FormNotice>
        )}
        <div className="flex justify-end">
          <Button size="sm" disabled={send.isPending || !enabled}>
            {send.isPending ? "Escalating…" : "Escalate"}
          </Button>
        </div>
      </form>
    </details>
  );
}

function CancelQuestion({
  project,
  question,
  enabled,
}: {
  project: string;
  question: Question;
  enabled: boolean;
}) {
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [missing, setMissing] = useState(false);
  const freeze = useFrozenCommand<QuestionCancelCommand>();
  const send = useMutation({
    mutationFn: (text: string) =>
      questionAction(project, question.id, {
        action: "cancel",
        command: freeze(text, (key) => ({
          ...correlation(question),
          idempotency_key: key,
          reason: text,
        })),
      }),
    onSettled: () =>
      client.invalidateQueries({ queryKey: ["questions", project] }),
    onSuccess: () => setOpen(false),
  });
  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        disabled={!enabled}
        onClick={() => {
          send.reset();
          setMissing(false);
          setOpen(true);
        }}
      >
        Cancel question
      </Button>
      <ConfirmAction
        open={open}
        onOpenChange={setOpen}
        title="Cancel this question"
        confirmLabel="Cancel question"
        pending={send.isPending}
        error={
          missing
            ? "Enter a reason."
            : send.isError
              ? failureKind(send.error) === "conflict"
                ? conflictText(send.error, question)
                : failureMessage(send.error)
              : undefined
        }
        onConfirm={() => {
          const text = reason.trim();
          setMissing(!text);
          if (text) send.mutate(text);
        }}
        description={
          <div className="space-y-3">
            <p>
              The worker gets no answer. The question and its history stay
              visible.
            </p>
            <TextField
              label="Reason"
              required
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
        }
      />
    </>
  );
}

/** A worker question with its task/attempt correlation and every hand-over. */
export function DecisionDetail({
  project,
  id,
  close,
}: {
  project: string;
  id: string;
  close: () => void;
}) {
  const whoami = useWhoami();
  const allowed = rights(whoami.data, project);
  const query = useQuery({
    queryKey: ["questions", project, "item", id],
    queryFn: () => getQuestion(project, id),
    refetchInterval: 5_000,
  });
  const question = query.data?.question;
  const may = question ? decisionRights(question, whoami.data, allowed) : null;
  const fresh = !query.isError && query.fetchStatus !== "paused";

  return (
    <Drawer title="Decision" onClose={close}>
      <div className="space-y-6 p-6">
        {query.isPending && (
          <p className="text-sm text-muted-foreground">Loading question…</p>
        )}
        {query.isError && !question && (
          <FormNotice>
            {failureKind(query.error) === "forbidden"
              ? "This question is not available to this credential."
              : `The question could not be loaded: ${failureMessage(query.error)}`}
          </FormNotice>
        )}
        {query.isError && question && (
          <FormNotice tone="warning">
            Showing the last loaded version; refreshing failed. Actions are
            paused until it succeeds.
          </FormNotice>
        )}
        {question && may && (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={QUESTION_STATE[question.state].variant}>
                {QUESTION_STATE[question.state].label}
              </Badge>
              {question.escalated && (
                <Badge variant="secondary">Escalated to owner</Badge>
              )}
            </div>
            <section aria-label="Question" className="space-y-2">
              <h2 className="tila-label">Question</h2>
              <p className="whitespace-pre-wrap text-base text-foreground">
                {question.text}
              </p>
            </section>
            <dl className="grid grid-cols-[minmax(7rem,auto)_1fr] gap-x-4 gap-y-2 text-sm">
              <Row label="Task">
                <Link
                  className={linkClass}
                  to={`/p/${project}/tasks/${encodeURIComponent(question.task_id)}`}
                >
                  {question.task_id}
                </Link>
              </Row>
              <Row label="Attempt">
                <Link
                  className={linkClass}
                  to={`/p/${project}/tasks/${encodeURIComponent(question.task_id)}?attempt=${encodeURIComponent(question.attempt_id)}`}
                >
                  <span className="font-mono">{question.attempt_id}</span>
                </Link>
              </Row>
              <Row label="Asked by">
                <span className="break-all font-mono text-xs">
                  {question.requester.principal_id} ·{" "}
                  {question.requester.participant_id}
                  {question.requester_binding &&
                    ` · agent ${question.requester_binding.agent_id}`}
                </span>
              </Row>
              <Row
                label={question.state === "open" ? "Waiting on" : "Responder"}
              >
                <span className="break-all font-mono text-xs">
                  {question.responder_principal_id}
                </span>
                {may.responder && " (you)"}
              </Row>
              <Row label="Asked">
                <span title={formatDateTime(question.created_at)}>
                  {relativeTime(question.created_at)}
                </span>
              </Row>
            </dl>

            {question.answer && (
              <section aria-label="Answer" className="space-y-2">
                <h2 className="tila-label">Answer</h2>
                <p className="whitespace-pre-wrap text-sm text-foreground">
                  {question.answer.text}
                </p>
                <p className="font-mono text-xs text-muted-foreground">
                  {question.answer.actor.principal_id} ·{" "}
                  {question.answer.actor.participant_id} ·{" "}
                  {formatDateTime(question.answer.at)}
                </p>
              </section>
            )}
            {question.invalidation_reason && (
              <FormNotice tone="info">
                {question.state === "superseded" ? "Superseded: " : "Closed: "}
                {question.invalidation_reason}
              </FormNotice>
            )}

            {question.routing.length > 0 && (
              <section aria-label="Routing history" className="space-y-2">
                <h2 className="tila-label">Routing history</h2>
                <ol className="space-y-2 text-sm">
                  {question.routing.map((step) => (
                    <li
                      key={`${step.revision}-${step.at}`}
                      className="border-b border-border pb-2 last:border-0"
                    >
                      {step.escalated ? "Escalated" : "Routed"} to{" "}
                      <span className="font-mono">
                        {step.responder_principal_id}
                      </span>{" "}
                      by{" "}
                      <span className="font-mono">
                        {step.actor.principal_id}
                      </span>
                      <span className="text-muted-foreground">
                        {" "}
                        · {formatDateTime(step.at)}
                      </span>
                      {step.reason && <p>{step.reason}</p>}
                    </li>
                  ))}
                </ol>
              </section>
            )}

            {question.discussion.length > 0 && (
              <section aria-label="Discussion" className="space-y-1">
                <h2 className="tila-label">Discussion</h2>
                <ul className="space-y-1 text-sm">
                  {question.discussion.map((d) => (
                    <li key={d.message_id}>
                      <Link
                        className={linkClass}
                        to={`/p/${project}/rooms/${encodeURIComponent(d.room_id)}`}
                      >
                        Room {d.room_id}
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {question.state !== "open" && whoami.data?.principal_id && (
              <UnsentAnswer
                project={project}
                question={question}
                principal={whoami.data.principal_id}
                why={`This question is ${QUESTION_STATE[question.state].label.toLowerCase()}.`}
              />
            )}
            {question.state === "open" && (
              <section aria-label="Respond" className="space-y-4">
                <h2 className="tila-label">Respond</h2>
                {may.answer && whoami.data?.principal_id ? (
                  <AnswerForm
                    project={project}
                    question={question}
                    principal={whoami.data.principal_id}
                    enabled={fresh}
                  />
                ) : (
                  <>
                    <p className="text-sm text-muted-foreground">
                      {!allowed.decide
                        ? "This credential can read decisions but not answer them."
                        : may.responder && question.escalated
                          ? "This question was escalated to an owner; only an owner can answer it."
                          : "Only the principal it is waiting on can answer it."}
                    </p>
                    {whoami.data?.principal_id && (
                      <UnsentAnswer
                        project={project}
                        question={question}
                        principal={whoami.data.principal_id}
                        why="You can no longer answer this question."
                      />
                    )}
                  </>
                )}
                {(may.escalate || may.cancel) && (
                  <div className="space-y-3">
                    {may.escalate && (
                      <EscalateForm
                        project={project}
                        question={question}
                        enabled={fresh}
                      />
                    )}
                    {may.cancel && (
                      <CancelQuestion
                        project={project}
                        question={question}
                        enabled={fresh}
                      />
                    )}
                  </div>
                )}
              </section>
            )}
          </>
        )}
      </div>
    </Drawer>
  );
}
