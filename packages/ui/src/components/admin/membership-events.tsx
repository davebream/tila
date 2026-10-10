import { Button } from "@/components/ui/button";
import { QuerySection } from "@/components/ui/query-section";
import { type MembershipEvent, listMembershipEvents } from "@/lib/api";
import type { SectionState } from "@/lib/query-state";
import { formatDateTime } from "@/lib/time";
import { useState } from "react";

interface MembershipEventsProps {
  projectId: string;
  state: SectionState<{
    events: MembershipEvent[];
    next_cursor: number | null;
  }>;
  onRetry: () => void;
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
  state,
  onRetry,
}: MembershipEventsProps) {
  const [extra, setExtra] = useState<MembershipEvent[]>([]);
  const [cursor, setCursor] = useState<number | null | undefined>(undefined);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreFailed, setLoadMoreFailed] = useState(false);
  const nextCursor = state.phase === "ready" ? state.data.next_cursor : null;
  const effectiveCursor = cursor === undefined ? nextCursor : cursor;

  async function loadMore() {
    if (effectiveCursor === null) return;
    setLoadingMore(true);
    setLoadMoreFailed(false);
    try {
      const page = await listMembershipEvents(projectId, {
        cursor: effectiveCursor,
        limit: 20,
      });
      setExtra((prev) => [...prev, ...page.events]);
      setCursor(page.next_cursor);
    } catch {
      // Keep the cursor: a failed page must not look like the end of the list.
      setLoadMoreFailed(true);
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <section aria-labelledby="membership-events-heading" className="space-y-2">
      <h3 id="membership-events-heading" className="tila-label">
        Recent membership changes
      </h3>
      <QuerySection
        state={state}
        label="membership changes"
        empty="No changes recorded."
        onRetry={onRetry}
      >
        {({ events }) => (
          <ul className="space-y-1 font-mono text-xs">
            {[...events, ...extra].map((event) => (
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
      </QuerySection>
      {loadMoreFailed && (
        <p role="alert" className="text-xs text-status-red">
          Could not load more changes.
        </p>
      )}
      {effectiveCursor !== null && state.phase === "ready" && (
        <Button
          variant="ghost"
          size="xs"
          disabled={loadingMore}
          onClick={loadMore}
        >
          {loadingMore ? "Loading…" : loadMoreFailed ? "Retry" : "Load more"}
        </Button>
      )}
    </section>
  );
}
