import { LastRefreshed } from "@/components/ui/last-refreshed";
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
import { relativeTime } from "@/lib/time";
import type { SignalIdentity, SignalTarget } from "@tila/schemas";

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

export function SignalsPage() {
  const history = useSignalHistory();
  const groups = useSignalGroups();
  const signals = history.data?.signals ?? [];

  return (
    <div className="space-y-6 p-3 md:p-6">
      <div className="flex items-center gap-3">
        <h1 className="font-logo text-xl tracking-tight text-foreground">
          Signals
        </h1>
        {signals.length > 0 && (
          <span className="tila-num rounded-full border border-border bg-card px-[7px] py-px font-mono text-[11px] text-fg-faint">
            {signals.length}
          </span>
        )}
        <LastRefreshed dataUpdatedAt={history.dataUpdatedAt} />
      </div>

      {history.isError ? (
        <TableError error={history.error} onRetry={() => history.refetch()} />
      ) : history.isLoading ? (
        <SignalSkeleton />
      ) : signals.length === 0 ? (
        <p className="py-8 text-center text-muted-foreground">
          No unexpired signals.
        </p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border">
          <Table aria-label="Signal history">
            <TableHeader>
              <TableRow>
                <TableHead>Signal</TableHead>
                <TableHead>Target</TableHead>
                <TableHead>Sender</TableHead>
                <TableHead>Acknowledged</TableHead>
                <TableHead className="text-right">Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {signals.map((signal) => {
                const acknowledged = signal.deliveries.filter(
                  (delivery) => delivery.acknowledged_at !== null,
                ).length;
                return (
                  <TableRow key={signal.id}>
                    <TableCell>
                      <div className="text-fg-strong">{signal.kind}</div>
                      <div className="font-mono text-xs text-muted-foreground">
                        {signal.id}
                      </div>
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {targetLabel(signal.target)}
                    </TableCell>
                    <TableCell className="text-xs">
                      {identityLabel(signal.sender)}
                    </TableCell>
                    <TableCell>
                      <div className="tila-num">
                        {acknowledged}/{signal.deliveries.length}
                      </div>
                      <div className="mt-1 space-y-1 text-xs text-muted-foreground">
                        {signal.deliveries.map((delivery) => (
                          <div
                            key={`${delivery.recipient.principal_id}:${delivery.recipient.participant_id}`}
                          >
                            {delivery.acknowledged_at === null
                              ? "pending"
                              : "acked"}
                            :{" "}
                            {identityLabel(
                              delivery.acknowledged_by ?? delivery.recipient,
                            )}
                          </div>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell className="tila-num text-right text-muted-foreground">
                      {relativeTime(signal.created_at)}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      <section className="space-y-3">
        <h2 className="font-logo text-lg tracking-tight text-foreground">
          Groups
        </h2>
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
            <TableHead>Acknowledged</TableHead>
            <TableHead>Created</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableSkeleton rows={4} columns={5} />
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
