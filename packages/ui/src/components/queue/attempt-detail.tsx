import { Button } from "@/components/ui/button";
import { Drawer } from "@/components/ui/drawer";
import { QuerySection, SectionNotice } from "@/components/ui/query-section";
import {
  controlAttempt,
  correctAttempt,
  dashboardParticipantId,
  getAttempt,
} from "@/lib/api";
import { deriveSectionState } from "@/lib/query-state";
import { controlsAttempt } from "@/lib/rights";
import { useQuery } from "@tanstack/react-query";
import type {
  AttemptCorrectCommand,
  AttemptRequest,
  AttemptRevisionSnapshot,
  AttemptView,
  WhoamiResponse,
  WorkAttempt,
} from "@tila/schemas";
import { type ReactNode, useRef, useState } from "react";
import { Link } from "react-router";
import {
  Failure,
  Field,
  inputClass,
  revision,
  rights,
  useAction,
} from "./shared";
function SafeLink({
  value,
  children,
}: { value: string; children?: ReactNode }) {
  if (!/^https?:\/\//i.test(value))
    return <span className="break-all font-mono text-xs">{value}</span>;
  return (
    <a
      className="text-signal-blue underline break-all"
      href={value}
      rel="noreferrer"
      target="_blank"
    >
      {children ?? value}
    </a>
  );
}
const at = (ms: number) => (
  <time dateTime={new Date(ms).toISOString()}>
    {new Date(ms).toLocaleString()}
  </time>
);
const definition = (version: number | null) =>
  version === null ? "none" : `v${version}`;

/** Definition and policy revisions in force at each transition, and now. */
function Revisions({ view }: { view: AttemptView }) {
  const captured = view.attempt.revisions;
  const current = view.current_revisions;
  const authorized = captured?.authorized;
  const rows: [string, AttemptRevisionSnapshot | undefined][] = [
    ["Reserved", captured?.reserved],
    ["Authorized", authorized],
    ["Finished", captured?.finished],
  ];
  return (
    <section className="space-y-2">
      <h3 className="font-medium">Governing revisions</h3>
      {captured === null ? (
        <p className="text-sm text-muted-foreground">
          Not recorded. This attempt predates revision capture.
        </p>
      ) : (
        <table
          aria-label="Governing revisions"
          className="w-full text-left font-mono text-xs"
        >
          <thead className="text-muted-foreground">
            <tr>
              <th className="py-1 font-normal">Transition</th>
              <th className="py-1 font-normal">Definition</th>
              <th className="py-1 font-normal">Policy</th>
              <th className="py-1 font-normal">At</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([label, snapshot]) => (
              <tr key={label} className="border-t border-border">
                <th scope="row" className="py-1 font-normal">
                  {label}
                </th>
                {snapshot ? (
                  <>
                    <td className="py-1">
                      {definition(snapshot.definition_version)}
                    </td>
                    <td className="py-1">r{snapshot.policy_revision}</td>
                    <td className="py-1">{at(snapshot.at)}</td>
                  </>
                ) : (
                  <td className="py-1 text-muted-foreground" colSpan={3}>
                    —
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {current && (
        <p className="font-mono text-xs">
          Current: definition {definition(current.definition_version)} · policy
          r{current.policy_revision}
        </p>
      )}
      {current &&
        authorized &&
        current.definition_version !== authorized.definition_version && (
          <p className="text-xs text-status-amber">
            Definition changed since authorization (
            {definition(authorized.definition_version)} →{" "}
            {definition(current.definition_version)}). Later transitions
            validate against the current rules.
          </p>
        )}
    </section>
  );
}

/** Corrective work linked to a finished attempt. The result itself never changes. */
function Corrections({
  project,
  view,
  identity,
  fresh,
}: {
  project: string;
  view: AttemptView;
  identity?: WhoamiResponse;
  fresh: boolean;
}) {
  const { attempt } = view;
  const corrections = view.corrections ?? [];
  const canCorrect = rights(identity, project).edit;
  const [task, setTask] = useState("");
  const [reason, setReason] = useState("");
  // One idempotency key per submission; a retry of the same input reuses it.
  const submission = useRef<{ body: string; key: string } | undefined>(
    undefined,
  );
  const action = useAction(project, (command: AttemptCorrectCommand) =>
    correctAttempt(project, attempt.id, command),
  );
  if (attempt.state !== "terminal" && corrections.length === 0) return null;
  return (
    <section className="space-y-2">
      <h3 className="font-medium">Corrective work</h3>
      {corrections.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No corrective work linked.
        </p>
      ) : (
        <ul aria-label="Corrective work" className="space-y-2 text-sm">
          {corrections.map((correction) => (
            <li
              key={correction.id}
              className="border-b border-border pb-2 last:border-0"
            >
              <Link
                className="font-mono text-signal-blue"
                to={`/p/${project}/tasks/${encodeURIComponent(correction.task_id)}`}
              >
                {correction.task_id}
              </Link>
              <p>{correction.reason}</p>
              <p className="font-mono text-xs text-muted-foreground break-all">
                {correction.principal_id} · {correction.participant_id} ·{" "}
                {at(correction.created_at)}
              </p>
            </li>
          ))}
        </ul>
      )}
      {attempt.state === "terminal" && canCorrect && (
        <form
          aria-label="Link corrective task"
          className="grid gap-3 rounded-lg border border-border p-4"
          onSubmit={(event) => {
            event.preventDefault();
            const input = { task_id: task.trim(), reason: reason.trim() };
            const body = JSON.stringify(input);
            if (submission.current?.body !== body)
              submission.current = { body, key: crypto.randomUUID() };
            action.mutate(
              { ...input, idempotency_key: submission.current.key },
              {
                onSuccess: () => {
                  submission.current = undefined;
                  setTask("");
                  setReason("");
                },
              },
            );
          }}
        >
          <p className="text-xs text-muted-foreground">
            Link a task that fixes or follows up on this result. The original
            result stays unchanged.
          </p>
          <Field
            label="Corrective task ID"
            required
            value={task}
            onChange={(event) => setTask(event.target.value)}
          />
          <Field
            label="Correction reason"
            required
            maxLength={2000}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
          <Button
            disabled={
              !fresh || !task.trim() || !reason.trim() || action.isPending
            }
          >
            Link corrective task
          </Button>
          <Failure error={action.error} />
          {action.isSuccess && (
            <output className="text-sm">Corrective task linked.</output>
          )}
        </form>
      )}
    </section>
  );
}

function AttemptActions({
  project,
  attempt,
  assigner,
  identity,
  fresh,
}: {
  project: string;
  attempt: WorkAttempt;
  /** Undefined when the server does not report the assigner. */
  assigner?: string | null;
  identity?: WhoamiResponse;
  fresh: boolean;
}) {
  const permission = rights(identity, project);
  const [reason, setReason] = useState("");
  const [observation, setObservation] = useState<
    "unknown" | "running" | "stopped" | "suspended"
  >("unknown");
  const [outcome, setOutcome] = useState<"success" | "failure" | "cancelled">(
    "failure",
  );
  const [provider, setProvider] = useState(attempt.session?.provider ?? "");
  const [session, setSession] = useState(attempt.session?.id ?? "");
  const [checkpoint, setCheckpoint] = useState(
    JSON.stringify(attempt.checkpoint ?? {}),
  );
  const [base, setBase] = useState(attempt.revision);
  const [principal, setPrincipal] = useState("");
  const [participant, setParticipant] = useState("");
  const [inputError, setInputError] = useState<unknown>();
  const action = useAction(
    project,
    (input: Exclude<AttemptRequest, { action: "get" | "list" }>) =>
      controlAttempt(project, input),
  );
  const own =
    identity?.principal_id === attempt.principal_id &&
    dashboardParticipantId() === attempt.participant_id;
  // Requests come from the owner, the principal that enrolled the work, or a
  // maintainer. Without the caller's principal or the assigner, leave the
  // decision to the server and show its refusal.
  const mayControl = controlsAttempt(
    identity,
    permission,
    attempt,
    assigner,
    dashboardParticipantId(),
  );
  const canOperate = fresh && mayControl && !action.isPending;
  const canReconcile =
    fresh && (permission.reconcile || (permission.operate && own));
  const terminal = attempt.state === "terminal";
  const request = (
    name: "request-cancellation" | "request-suspension" | "request-resume",
  ) =>
    action.mutate({
      action: name,
      id: attempt.id,
      command: revision(attempt.revision),
    });
  return (
    <div className="grid gap-4">
      {/* Controls the viewer may not use are absent, not disabled (DESIGN.md). */}
      {permission.operate && !mayControl ? (
        <p className="text-xs text-muted-foreground">
          Only the attempt owner, the principal that enrolled this work, or a
          maintainer can request changes or retry.
        </p>
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={
                !canOperate || terminal || attempt.cancellation_requested
              }
              onClick={() => request("request-cancellation")}
            >
              Request cancellation
            </Button>
            <Button
              variant="outline"
              disabled={
                !canOperate ||
                !["starting", "running"].includes(attempt.state) ||
                attempt.suspension_requested ||
                attempt.cancellation_requested
              }
              onClick={() => request("request-suspension")}
            >
              Request suspension
            </Button>
            <Button
              variant="outline"
              disabled={
                !canOperate ||
                attempt.state !== "suspended" ||
                attempt.cancellation_requested
              }
              onClick={() => request("request-resume")}
            >
              Request resume
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Requests do not stop or launch a process. The repository adapter
            must confirm execution stopped or safely suspended.
          </p>
          <Field
            label="Recovery or retry reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <Button
            variant="outline"
            disabled={
              !canOperate ||
              !terminal ||
              !attempt.outcome?.execution_stopped ||
              attempt.outcome.unresolved_external_execution ||
              attempt.outcome.status === "success" ||
              !reason.trim()
            }
            onClick={() =>
              action.mutate({
                action: "retry",
                id: attempt.id,
                command: { ...revision(base), reason },
              })
            }
          >
            Retry stopped work
          </Button>
        </>
      )}
      {canReconcile && !terminal && (
        <form
          className="grid gap-3 rounded-lg border border-border p-4"
          onSubmit={(e) => {
            e.preventDefault();
            setInputError(undefined);
            try {
              action.mutate({
                action: "reconcile",
                id: attempt.id,
                command: {
                  ...revision(base),
                  reason,
                  observation,
                  ...(observation === "running" || observation === "suspended"
                    ? { session: { ...attempt.session, provider, id: session } }
                    : {}),
                  ...(observation === "suspended"
                    ? {
                        execution_quiescent: true,
                        checkpoint: JSON.parse(checkpoint),
                      }
                    : {}),
                  ...(observation === "stopped"
                    ? {
                        outcome: {
                          status: outcome,
                          reason,
                          evidence: [],
                          execution_stopped: true,
                          unresolved_external_execution: false,
                        },
                      }
                    : {}),
                },
              });
            } catch (error) {
              setInputError(error);
            }
          }}
        >
          <label className="grid gap-1 text-xs">
            Verified execution observation
            <select
              aria-label="Verified execution observation"
              className={inputClass}
              value={observation}
              onChange={(e) =>
                setObservation(e.target.value as typeof observation)
              }
            >
              <option value="unknown">Unknown — keep reserved</option>
              <option value="running">Same execution is running</option>
              <option value="stopped">Execution has stopped</option>
              <option value="suspended">Execution is safely suspended</option>
            </select>
          </label>
          {(observation === "running" || observation === "suspended") && (
            <>
              <Field
                label="Session provider"
                required
                value={provider}
                onChange={(e) => setProvider(e.target.value)}
              />
              <Field
                label="Provider session ID"
                required
                value={session}
                onChange={(e) => setSession(e.target.value)}
              />
            </>
          )}
          {observation === "suspended" && (
            <Field
              label="Checkpoint JSON"
              required
              value={checkpoint}
              onChange={(e) => setCheckpoint(e.target.value)}
            />
          )}
          {observation === "stopped" && (
            <label>
              Observed result
              <select
                className={inputClass}
                aria-label="Observed result"
                value={outcome}
                onChange={(e) => setOutcome(e.target.value as typeof outcome)}
              >
                <option value="failure">Failure</option>
                <option value="success">Success</option>
                <option value="cancelled">Cancelled</option>
              </select>
            </label>
          )}
          <Button disabled={!reason.trim() || action.isPending}>
            Record reconciliation
          </Button>
        </form>
      )}
      {permission.force && !terminal && (
        <>
          <p className="text-xs text-muted-foreground">
            Force recovery abandons this attempt and permits a replacement. It
            records unresolved external execution; it does not kill the old
            process.
          </p>
          <Button
            variant="destructive"
            disabled={!fresh || !reason.trim() || action.isPending}
            onClick={() =>
              action.mutate({
                action: "force-recovery",
                id: attempt.id,
                command: { ...revision(base), reason },
              })
            }
          >
            Abandon and allow replacement
          </Button>
        </>
      )}
      {permission.force && !terminal && attempt.session && (
        <details className="rounded-lg border border-border p-4">
          <summary className="cursor-pointer text-sm">
            Rebind the recorded execution
          </summary>
          <form
            className="mt-3 grid gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (attempt.session)
                action.mutate({
                  action: "rebind",
                  id: attempt.id,
                  command: {
                    ...revision(base),
                    reason,
                    principal_id: principal,
                    participant_id: participant,
                    session: attempt.session,
                  },
                });
            }}
          >
            <p className="text-xs text-muted-foreground">
              Use after verifying the same execution still exists. This changes
              ownership and invalidates its previous authority.
            </p>
            <Field
              label="New principal ID"
              required
              value={principal}
              onChange={(event) => setPrincipal(event.target.value)}
            />
            <Field
              label="New participant ID"
              required
              value={participant}
              onChange={(event) => setParticipant(event.target.value)}
            />
            <Button disabled={!fresh || !reason.trim() || action.isPending}>
              Rebind ownership
            </Button>
          </form>
        </details>
      )}
      {base !== attempt.revision && (
        <Button
          variant="ghost"
          onClick={() => {
            setBase(attempt.revision);
            action.reset();
          }}
        >
          Use latest revision ({attempt.revision})
        </Button>
      )}
      <Failure error={inputError ?? action.error} />
      {action.isSuccess && (
        <output className="text-sm">
          Request recorded. The current attempt state appears above.
        </output>
      )}
    </div>
  );
}
export function AttemptDetail({
  project,
  id,
  identity,
  close,
}: {
  project: string;
  id: string;
  identity?: WhoamiResponse;
  close: () => void;
}) {
  const query = useQuery({
    queryKey: ["queue-attempt", project, id],
    queryFn: () => getAttempt(project, id),
    enabled: !!project,
    refetchInterval: 5_000,
  });
  return (
    <Drawer title="Work attempt" onClose={close}>
      <div className="space-y-5 p-6">
        <QuerySection
          state={deriveSectionState(query)}
          label="attempt"
          empty="Attempt not found."
          onRetry={() => void query.refetch()}
        >
          {(view, { stale }) => {
            const { attempt } = view;
            const fresh = !stale && query.fetchStatus !== "paused";
            return (
              <>
                <h2 className="font-mono break-all">{attempt.id}</h2>
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
                  <dt>Task</dt>
                  <dd>
                    <Link
                      className="text-signal-blue"
                      to={`/p/${project}/tasks/${encodeURIComponent(attempt.task_id)}`}
                    >
                      {attempt.task_id}
                    </Link>
                  </dd>
                  <dt>State</dt>
                  <dd>{attempt.state}</dd>
                  <dt>Principal</dt>
                  <dd className="break-all">{attempt.principal_id}</dd>
                  <dt>Participant</dt>
                  <dd className="break-all">{attempt.participant_id}</dd>
                  {view.assigner_principal_id !== undefined && (
                    <>
                      <dt>Enrolled by</dt>
                      <dd className="break-all">
                        {view.assigner_principal_id ?? "Not recorded"}
                      </dd>
                    </>
                  )}
                  <dt>Fence / revision</dt>
                  <dd>
                    {attempt.fence} / {attempt.revision}
                  </dd>
                  <dt>Cancellation</dt>
                  <dd>
                    {attempt.cancellation_requested
                      ? "Requested; stop not yet confirmed"
                      : "Not requested"}
                  </dd>
                  <dt>Suspension</dt>
                  <dd>
                    {attempt.suspension_requested
                      ? "Requested; quiescence not yet confirmed"
                      : "Not requested"}
                  </dd>
                </dl>
                {attempt.session && (
                  <section className="space-y-2">
                    <h3 className="font-medium">Execution session</h3>
                    <p className="font-mono text-xs break-all">
                      {attempt.session.provider} · {attempt.session.id}
                    </p>
                    {attempt.session.host_id && (
                      <p>Host: {attempt.session.host_id}</p>
                    )}
                    {attempt.session.worktree && (
                      <p className="break-all">
                        Worktree: {attempt.session.worktree}
                      </p>
                    )}
                    {attempt.session.url && (
                      <SafeLink value={attempt.session.url}>
                        Open runtime session
                      </SafeLink>
                    )}
                  </section>
                )}
                {attempt.predecessor_id && (
                  <p>
                    Previous attempt:{" "}
                    <Link
                      className="text-signal-blue"
                      to={`?attempt=${encodeURIComponent(attempt.predecessor_id)}`}
                    >
                      {attempt.predecessor_id}
                    </Link>
                  </p>
                )}
                {attempt.outcome && (
                  <section>
                    <h3 className="font-medium">
                      Result: {attempt.outcome.status}
                    </h3>
                    <p>{attempt.outcome.reason}</p>
                    {attempt.outcome.unresolved_external_execution && (
                      <SectionNotice>
                        External execution remains unresolved.
                      </SectionNotice>
                    )}
                    <ul>
                      {attempt.outcome.evidence.map((value) => (
                        <li key={value}>
                          <SafeLink value={value} />
                        </li>
                      ))}
                    </ul>
                  </section>
                )}
                <Revisions view={view} />
                <Corrections
                  key={`corrections-${attempt.id}`}
                  project={project}
                  view={view}
                  identity={identity}
                  fresh={fresh}
                />
                <AttemptActions
                  key={attempt.id}
                  project={project}
                  attempt={attempt}
                  assigner={view.assigner_principal_id}
                  identity={identity}
                  fresh={fresh}
                />
              </>
            );
          }}
        </QuerySection>
      </div>
    </Drawer>
  );
}
