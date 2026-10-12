import { Button } from "@/components/ui/button";
import { LastRefreshed } from "@/components/ui/last-refreshed";
import { SectionFailure, StaleNotice } from "@/components/ui/query-section";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { TableError } from "@/components/ui/table-error";
import { TableSkeleton } from "@/components/ui/table-skeleton";
import { useSignalGroups, useSignalHistory } from "@/hooks/use-api";
import { useAuth } from "@/hooks/use-auth";
import { useTimeTick } from "@/hooks/use-time-tick";
import { leaseCountdown } from "@/lib/lease";
import { deriveSectionState } from "@/lib/query-state";
import { relativeTime } from "@/lib/time";
import type { SignalIdentity, SignalTarget } from "@tila/schemas";
import { Link } from "react-router";

function identityLabel(identity: SignalIdentity): string {
  const display = [
    identity.display_name,
    identity.environment.client_name,
    identity.environment.machine,
  ].filter(Boolean);
  return display.length > 0
    ? `${display.join(" · ")} (${identity.principal_id}/${identity.participant_id})`
    : `${identity.principal_id}/${identity.participant_id}`;
}

function targetLabel(target: SignalTarget): string {
  switch (target.type) {
    case "participant":
      return `${target.principal_id}/${target.participant_id}`;
    case "principal":
      return `principal ${target.principal_id}`;
    case "group":
      return `group ${target.group_id}`;
    case "broadcast":
      return "broadcast";
  }
}

const linkClass = "text-signal-blue underline";
const PAYLOAD_LIMIT = 4000;

/** Where a signal's free-form resource can be inspected in the dashboard. */
function resourceHref(project: string, resource: string): string {
  const p = `/p/${encodeURIComponent(project)}`;
  const [kind, ...rest] = resource.split(":");
  const id = rest.join(":");
  if (id && (kind === "task" || kind === "entity"))
    return `${p}/tasks/${encodeURIComponent(id)}`;
  if (id && kind === "record")
    return `${p}/records/${id.split("/").map(encodeURIComponent).join("/")}`;
  if (id && kind === "room") return `${p}/rooms/${encodeURIComponent(id)}`;
  return `${p}/journal?resource=${encodeURIComponent(resource)}`;
}

function Payload({ value }: { value: unknown }) {
  if (value === undefined || value === null)
    return <span className="text-muted-foreground">No payload</span>;
  const text = JSON.stringify(value, null, 2) ?? String(value);
  return (
    <details>
      <summary className="cursor-pointer text-xs">Payload</summary>
      <pre className="mt-1 max-h-48 w-56 overflow-auto whitespace-pre rounded bg-muted p-2 font-mono text-[11px]">
        {text.length > PAYLOAD_LIMIT
          ? `${text.slice(0, PAYLOAD_LIMIT)}\n… truncated`
          : text}
      </pre>
    </details>
  );
}

export function SignalsPage() {
  useTimeTick(1000);
  const now = Date.now();
  const { projectId } = useAuth();
  const history = useSignalHistory();
  const groups = useSignalGroups();
  const historyState = deriveSectionState(history, {
    isEmpty: (data) => data.pages.every((page) => page.signals.length === 0),
  });
  const signals = history.data?.pages.flatMap((page) => page.signals) ?? [];

  return (
    <div className="space-y-6 p-3 md:p-6">
      <div className="flex items-center gap-3">
        <h1 className="font-logo text-xl tracking-tight text-foreground">
          Signals
        </h1>
        {signals.length > 0 && (
          <span className="tila-num rounded-full border border-border bg-card px-[7px] py-px font-mono text-[11px] text-fg-faint">
            {signals.length}
            {history.hasNextPage ? "+" : ""}
          </span>
        )}
        <LastRefreshed dataUpdatedAt={history.dataUpdatedAt} />
      </div>

      {historyState.phase === "pending" ? (
        <SignalSkeleton />
      ) : historyState.phase === "failed" ? (
        <SectionFailure
          kind={historyState.kind}
          error={historyState.error}
          label="signal history"
          onRetry={() => void history.refetch()}
          forbidden="Signal history requires admin access (maintainer role or signals:manage). Your own unacknowledged signals stay in your inbox."
        />
      ) : (
        <div className="space-y-3">
          {historyState.stale && (
            <StaleNotice
              label="signal history"
              updatedAt={historyState.updatedAt}
              stale={historyState.stale}
              onRetry={() => void history.refetch()}
            />
          )}
          {historyState.empty ? (
            <p className="py-8 text-center text-muted-foreground">
              No unexpired signals.
            </p>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-border">
              <Table aria-label="Signal history">
                <TableHeader>
                  <TableRow>
                    <TableHead>Signal</TableHead>
                    <TableHead>Target</TableHead>
                    <TableHead>Sender</TableHead>
                    <TableHead>Recipients</TableHead>
                    <TableHead>Payload</TableHead>
                    <TableHead className="text-right">Expires</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {signals.map((signal) => {
                    const acknowledged = signal.deliveries.filter(
                      (delivery) => delivery.acknowledged_at !== null,
                    ).length;
                    return (
                      <TableRow key={signal.id} className="align-top">
                        <TableCell>
                          <div className="text-fg-strong">{signal.kind}</div>
                          <div className="font-mono text-xs text-muted-foreground">
                            {signal.id}
                          </div>
                          {signal.resource && projectId && (
                            <Link
                              className={`${linkClass} text-xs`}
                              to={resourceHref(projectId, signal.resource)}
                            >
                              {signal.resource}
                            </Link>
                          )}
                        </TableCell>
                        <TableCell className="font-mono text-xs">
                          {targetLabel(signal.target)}
                        </TableCell>
                        <TableCell className="min-w-40 whitespace-normal text-xs">
                          {identityLabel(signal.sender)}
                          <div className="text-muted-foreground">
                            sent {relativeTime(signal.created_at)}
                          </div>
                        </TableCell>
                        <TableCell className="min-w-48 whitespace-normal">
                          <div className="tila-num">
                            {acknowledged}/{signal.deliveries.length}{" "}
                            acknowledged
                          </div>
                          <div className="mt-1 space-y-1 text-xs text-muted-foreground">
                            {signal.deliveries.map((delivery) => (
                              <div
                                key={`${delivery.recipient.principal_id}:${delivery.recipient.participant_id}`}
                              >
                                {delivery.acknowledged_at === null
                                  ? "stored, pending"
                                  : "acked"}
                                :{" "}
                                {identityLabel(
                                  delivery.acknowledged_by ??
                                    delivery.recipient,
                                )}
                              </div>
                            ))}
                          </div>
                        </TableCell>
                        <TableCell>
                          <Payload value={signal.payload} />
                        </TableCell>
                        <TableCell className="tila-num text-right text-xs">
                          <time
                            dateTime={new Date(signal.expires_at).toISOString()}
                          >
                            {new Date(signal.expires_at).toLocaleString()}
                          </time>
                          <div className="text-muted-foreground">
                            {leaseCountdown(signal.expires_at, now)}
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
          {history.hasNextPage && (
            <Button
              variant="outline"
              size="sm"
              disabled={history.isFetchingNextPage}
              onClick={() => void history.fetchNextPage()}
            >
              {history.isFetchingNextPage ? "Loading…" : "Load more"}
            </Button>
          )}
          <p className="text-xs text-muted-foreground">
            Signals have no wake stage: each recipient is stored, then
            acknowledged or left pending. Expired signals are swept and no
            longer listed; absence is not evidence that a signal never existed.
          </p>
        </div>
      )}

      <section className="space-y-3">
        <h2 className="font-logo text-lg tracking-tight text-foreground">
          Groups
        </h2>
        <p className="text-xs text-muted-foreground">
          Read-only here; group editing belongs in Settings. Changing a group
          never rewrites signals that were already sent.
        </p>
        {groups.isError ? (
          <TableError error={groups.error} onRetry={() => groups.refetch()} />
        ) : groups.isLoading ? (
          <GroupSkeleton />
        ) : (groups.data?.groups.length ?? 0) === 0 ? (
          <p className="py-6 text-center text-muted-foreground">
            No signal groups configured.
          </p>
        ) : (
          <div className="overflow-hidden rounded-lg border border-border">
            <Table aria-label="Signal groups">
              <TableHeader>
                <TableRow>
                  <TableHead>Group</TableHead>
                  <TableHead>Principals</TableHead>
                  <TableHead className="text-right">Updated</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {groups.data?.groups.map((group) => (
                  <TableRow key={group.id}>
                    <TableCell>
                      <div className="text-fg-strong">{group.name}</div>
                      <div className="font-mono text-xs text-muted-foreground">
                        {group.id}
                      </div>
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {group.principal_ids.join(", ")}
                    </TableCell>
                    <TableCell className="tila-num text-right text-muted-foreground">
                      {relativeTime(group.updated_at)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>
    </div>
  );
}

function SignalSkeleton() {
  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <Table aria-label="Signal history">
        <TableHeader>
          <TableRow>
            <TableHead>Signal</TableHead>
            <TableHead>Target</TableHead>
            <TableHead>Sender</TableHead>
            <TableHead>Recipients</TableHead>
            <TableHead>Payload</TableHead>
            <TableHead>Expires</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableSkeleton rows={4} columns={6} />
        </TableBody>
      </Table>
    </div>
  );
}

function GroupSkeleton() {
  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <Table aria-label="Signal groups">
        <TableHeader>
          <TableRow>
            <TableHead>Group</TableHead>
            <TableHead>Principals</TableHead>
            <TableHead>Updated</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableSkeleton rows={2} columns={3} />
        </TableBody>
      </Table>
    </div>
  );
}
