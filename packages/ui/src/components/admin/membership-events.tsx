import { Button } from "@/components/ui/button";
import { type MembershipEvent, listMembershipEvents } from "@/lib/api";
import { formatDateTime } from "@/lib/time";
import { useState } from "react";

interface MembershipEventsProps {
  projectId: string;
  events: MembershipEvent[];
  nextCursor: number | null;
  isLoading: boolean;
}

function describe(event: MembershipEvent): string {
  const role = event.role ? ` ${event.role}` : "";
  switch (event.action) {
    case "grant":
      return `granted${role}`;
    case "role-change": {
      const previous = event.details?.previous_role;
      return previous
        ? `role ${String(previous)} → ${event.role}`
        : `role →${role}`;
    }
    case "revoke":
      return "revoked";
    case "policy-change":
      return `policy → ${String(event.details?.mode ?? "")}`;
    default:
      return event.action;
  }
}

export function MembershipEvents({
  projectId,
  events,
  nextCursor,
  isLoading,
}: MembershipEventsProps) {
  const [extra, setExtra] = useState<MembershipEvent[]>([]);
  const [cursor, setCursor] = useState<number | null | undefined>(undefined);
  const [loadingMore, setLoadingMore] = useState(false);
  const effectiveCursor = cursor === undefined ? nextCursor : cursor;
  const all = [...events, ...extra];

  async function loadMore() {
    if (effectiveCursor === null) return;
    setLoadingMore(true);
    try {
      const page = await listMembershipEvents(projectId, {
        cursor: effectiveCursor,
        limit: 20,
      });
      setExtra((prev) => [...prev, ...page.events]);
      setCursor(page.next_cursor);
    } catch {
      setCursor(null);
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <section aria-labelledby="membership-events-heading" className="space-y-2">
      <h3 id="membership-events-heading" className="tila-label">
        Recent membership changes
      </h3>
      {isLoading ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : all.length === 0 ? (
        <p className="text-xs text-muted-foreground">No changes recorded.</p>
      ) : (
        <ul className="space-y-1 font-mono text-xs">
          {all.map((event) => (
            <li key={event.event_id} className="flex flex-wrap gap-x-3">
              <span className="tila-num text-muted-foreground">
                {formatDateTime(event.occurred_at)}
              </span>
              <span className="text-fg-strong">{event.principal_id}</span>
              <span>{describe(event)}</span>
              <span className="text-muted-foreground">
                by {event.actor_principal_id}
              </span>
            </li>
          ))}
        </ul>
      )}
      {effectiveCursor !== null && !isLoading && (
        <Button
          variant="ghost"
          size="xs"
          disabled={loadingMore}
          onClick={loadMore}
        >
          {loadingMore ? "Loading…" : "Load more"}
        </Button>
      )}
    </section>
  );
}
