import { Badge } from "@/components/ui/badge";
import { QuerySection } from "@/components/ui/query-section";
import { inspectDelivery } from "@/lib/api";
import { deriveSectionState } from "@/lib/query-state";
import { useQuery } from "@tanstack/react-query";
import type {
  Delivery,
  DeliveryMessageRef,
  DeliverySummary,
  DeliveryTrace,
} from "@tila/schemas";
import type { ReactNode } from "react";
import { Link } from "react-router";

type Tone = "green" | "amber" | "red" | "gray";
const at = (ms: number) => (
  <time dateTime={new Date(ms).toISOString()}>
    {new Date(ms).toLocaleString()}
  </time>
);

const WAKE: Record<DeliveryTrace["wake"]["status"], [string, Tone]> = {
  "not-requested": ["Not requested", "gray"],
  requested: ["Requested, awaiting report", "amber"],
  accepted: ["Accepted by connector", "green"],
  rejected: ["Rejected by connector", "red"],
  deferred: ["Deferred", "amber"],
  unknown: ["Outcome unknown", "amber"],
  suppressed: ["Suppressed", "amber"],
};
export function wakeLabel(wake: DeliveryTrace["wake"]) {
  const [label, tone] = WAKE[wake.status];
  return {
    label: wake.suppressed ? `${label} · ${wake.suppressed} budget` : label,
    tone,
  };
}
export function ackLabel(trace: DeliveryTrace): [string, Tone] {
  if (!trace.acknowledged) return ["Not acknowledged", "gray"];
  return trace.acknowledged.disposition === "declined"
    ? ["Declined", "amber"]
    : ["Accepted for processing", "green"];
}

const RECIPIENT: Record<
  DeliveryTrace["recipient"]["status"],
  [string, Tone] | null
> = {
  active: null,
  offline: ["Recipient offline", "amber"],
  replaced: ["Binding replaced", "red"],
  released: ["Binding released", "amber"],
  expired: ["Binding expired", "amber"],
  none: ["No binding", "amber"],
};
const STATE: Record<DeliveryTrace["state"], [string, Tone]> = {
  pending: ["Pending", "amber"],
  acked: ["Acknowledged", "green"],
  expired: ["Expired", "gray"],
};

/** Delivery state plus the recipient condition that explains a stuck delivery. */
export function TraceBadges({ trace }: { trace: DeliveryTrace }) {
  const [state, tone] = STATE[trace.state];
  const recipient = RECIPIENT[trace.recipient.status];
  return (
    <span className="inline-flex flex-wrap gap-1">
      <Badge variant={tone}>{state}</Badge>
      {recipient && trace.state === "pending" && (
        <Badge variant={recipient[1]}>{recipient[0]}</Badge>
      )}
    </span>
  );
}

export function SummaryLine({ summary }: { summary: DeliverySummary }) {
  if (summary.recipients === 0)
    return <>Stored. No agent recipients were snapshotted for this message.</>;
  return (
    <>
      Stored for {summary.recipients}{" "}
      {summary.recipients === 1 ? "recipient" : "recipients"} ·{" "}
      {summary.pending} pending · {summary.acknowledged} acknowledged ·{" "}
      {summary.expired} expired
    </>
  );
}

function Stage({
  name,
  tone,
  status,
  children,
}: {
  name: string;
  tone: Tone;
  status: string;
  children?: ReactNode;
}) {
  return (
    <li className="grid grid-cols-[8rem_1fr] gap-3 py-2">
      <span className="text-muted-foreground">{name}</span>
      <div className="space-y-1">
        <Badge variant={tone}>{status}</Badge>
        {children && (
          <p className="text-xs text-muted-foreground">{children}</p>
        )}
      </div>
    </li>
  );
}

/**
 * Stored, wake, fetch, acknowledgement and work result as separate facts.
 * Acknowledgement records accepted processing or decline, never completion.
 */
export function TraceStages({ trace }: { trace: DeliveryTrace }) {
  const wake = wakeLabel(trace.wake);
  const [ack, ackTone] = ackLabel(trace);
  return (
    <ol aria-label="Delivery stages" className="divide-y divide-border text-sm">
      <Stage name="Stored" tone="green" status="Stored">
        {at(trace.stored.at)}
      </Stage>
      <Stage name="Wake" tone={wake.tone} status={wake.label}>
        {trace.wake.attempts === 0
          ? "No wake attempt recorded."
          : `${trace.wake.attempts} ${trace.wake.attempts === 1 ? "attempt" : "attempts"} · ${trace.wake.rewakes} re-wakes after fetch`}
        {trace.wake.last_at !== null && <> · last {at(trace.wake.last_at)}</>}
      </Stage>
      <Stage
        name="Fetched"
        tone={trace.fetched ? "green" : "gray"}
        status={trace.fetched ? "Fetched" : "Not fetched"}
      >
        {trace.fetched ? (
          <>
            {at(trace.fetched.at)} by epoch {trace.fetched.epoch ?? "—"}.
            Fetching does not accept responsibility.
          </>
        ) : null}
      </Stage>
      <Stage name="Acknowledged" tone={ackTone} status={ack}>
        {trace.acknowledged ? (
          <>
            {at(trace.acknowledged.at)} by epoch{" "}
            {trace.acknowledged.epoch ?? "—"}
          </>
        ) : null}
      </Stage>
      <Stage name="Work result" tone="gray" status="Not reported">
        Acknowledgment is not completion. No work result has been recorded for
        this delivery.
      </Stage>
    </ol>
  );
}

/** Links from a delivery to the evidence around it. */
export function TraceLinks({
  project,
  delivery,
  message,
}: {
  project: string;
  delivery: Pick<Delivery, "id" | "agent_id">;
  message?: DeliveryMessageRef;
}) {
  const p = `/p/${encodeURIComponent(project)}`;
  const links: [string, string][] = [];
  if (message)
    links.push([
      `Open message #${message.seq} in room ${message.room_id}`,
      `${p}/rooms/${encodeURIComponent(message.room_id)}${message.thread_id ? `?thread=${encodeURIComponent(message.thread_id)}` : ""}`,
    ]);
  links.push(
    [
      "Delivery journal",
      `${p}/journal?resource=${encodeURIComponent(`delivery:${delivery.id}`)}`,
    ],
    [
      `Other deliveries for ${delivery.agent_id}`,
      `${p}/deliveries?agent=${encodeURIComponent(delivery.agent_id)}`,
    ],
    ["Agent mailbox status", `${p}/agents`],
  );
  if (message?.task_id)
    links.push([
      `Task ${message.task_id}`,
      `${p}/tasks/${encodeURIComponent(message.task_id)}`,
    ]);
  return (
    <ul aria-label="Related evidence" className="space-y-1 text-sm">
      {links.map(([label, to]) => (
        <li key={to}>
          <Link className="text-signal-blue underline" to={to}>
            {label}
          </Link>
        </li>
      ))}
      {message?.correlation_id && (
        <li className="text-xs text-muted-foreground">
          Correlation{" "}
          <span className="font-mono">{message.correlation_id}</span>
        </li>
      )}
    </ul>
  );
}

/** Metadata-only trace of one delivery; never fetches or acknowledges. */
export function DeliveryDetail({
  project,
  agent,
  delivery,
}: {
  project: string;
  agent: string;
  delivery: string;
}) {
  const query = useQuery({
    queryKey: ["delivery", project, agent, delivery],
    queryFn: () => inspectDelivery(project, agent, delivery),
    refetchInterval: 5000,
    retry: false,
  });
  return (
    <div className="space-y-4 p-6">
      <QuerySection
        state={deriveSectionState(query, { isEmpty: () => false })}
        label="delivery trace"
        empty=""
        onRetry={() => void query.refetch()}
        forbidden="Delivery traces require conversation management or the agent's current run."
        notFound="Delivery not found for this agent."
      >
        {(data) => (
          <div className="space-y-4">
            <p className="break-all font-mono text-xs">{data.delivery.id}</p>
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-lg">{data.reason.replaceAll("-", " ")}</p>
              {data.trace && <TraceBadges trace={data.trace} />}
            </div>
            {data.trace?.state === "expired" && (
              <p className="text-sm text-muted-foreground">
                Delivery metadata expired. The message is still in room history;
                expiry is not evidence that it was never sent.
              </p>
            )}
            {data.trace && <TraceStages trace={data.trace} />}
            <p className="text-xs text-muted-foreground">
              Acknowledgement records accepted processing or decline. It never
              means task completion.
            </p>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              <dt className="text-muted-foreground">Agent</dt>
              <dd>{data.delivery.agent_id}</dd>
              <dt className="text-muted-foreground">Target</dt>
              <dd>
                {data.delivery.target_epoch === null
                  ? "Any current binding"
                  : `Binding epoch ${data.delivery.target_epoch}`}
              </dd>
              <dt className="text-muted-foreground">Expires</dt>
              <dd>{at(data.delivery.expires_at)}</dd>
            </dl>
            <TraceLinks
              project={project}
              delivery={data.delivery}
              message={data.message}
            />
            <h2 className="font-medium">Wake attempts</h2>
            {data.attempts.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No wake attempts recorded.
              </p>
            ) : (
              <ol className="space-y-2">
                {data.attempts.map((attempt) => (
                  <li
                    key={attempt.id}
                    className="rounded border border-border p-3 text-sm"
                  >
                    {attempt.outcome} · epoch {attempt.binding_epoch} ·
                    publication {attempt.publish_gen}
                    <span className="block text-xs text-muted-foreground">
                      {at(attempt.created_at)}
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </div>
        )}
      </QuerySection>
    </div>
  );
}
