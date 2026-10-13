import {
  DeliveryDetail,
  TraceBadges,
  WorkResultBadge,
  ackLabel,
  wakeLabel,
} from "@/components/delivery-trace";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Drawer } from "@/components/ui/drawer";
import { QuerySection } from "@/components/ui/query-section";
import { useAuth } from "@/hooks/use-auth";
import { listAgents, listDeliveries, listRooms } from "@/lib/api";
import { deliveryFiltersFromSearch } from "@/lib/list-queries";
import { deriveSectionState } from "@/lib/query-state";
import { formatDateTime } from "@/lib/time";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type { DeliveryListQuery, DeliveryTraceItem } from "@tila/schemas";
import { useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";

const STATES = ["pending", "acked", "expired"] as const;
const STATE_LABEL = {
  pending: "Pending",
  acked: "Acknowledged",
  expired: "Expired",
} as const;

function FilterChip({
  label,
  remove,
  onRemove,
}: {
  label: string;
  remove: string;
  onRemove: () => void;
}) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-tint-blue-08 px-2.5 py-0.5 font-mono text-[11px] text-signal-blue">
      {label}
      <button
        type="button"
        onClick={onRemove}
        className="flex size-7 cursor-pointer items-center justify-center rounded-sm text-muted-foreground hover:text-foreground"
        aria-label={remove}
      >
        ×
      </button>
    </span>
  );
}

export function DeliveriesPage() {
  const { projectId } = useAuth();
  const { agentId, deliveryId } = useParams();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const returnFocus = useRef<HTMLElement | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const project = projectId as string;
  const filters: DeliveryListQuery = deliveryFiltersFromSearch(params);
  const [search, setSearch] = useState(filters.id ?? "");
  const setFilter = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };
  const agents = useQuery({
    queryKey: ["agents", projectId],
    queryFn: () => listAgents(project),
    enabled: !!projectId,
  });
  const rooms = useQuery({
    queryKey: ["rooms", projectId],
    queryFn: () => listRooms(project),
    enabled: !!projectId,
  });
  const deliveries = useInfiniteQuery({
    queryKey: ["deliveries", projectId, filters],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      listDeliveries(project, { ...filters, cursor: pageParam }),
    getNextPageParam: (page) => page.cursor ?? undefined,
    enabled: !!projectId,
    refetchInterval: 10000,
    retry: false,
  });
  const rows = deliveries.data?.pages.flatMap((page) => page.deliveries) ?? [];
  const total = deliveries.data?.pages[0]?.total;
  const filtered = Object.values(filters).some(Boolean);
  // Conversations need at least one agent and one room before anything can be delivered.
  const unavailable =
    agents.data?.agents.length === 0 || rooms.data?.rooms.length === 0;
  const refocus = () =>
    requestAnimationFrame(() =>
      (returnFocus.current?.isConnected
        ? returnFocus.current
        : heading.current
      )?.focus(),
    );
  const close = () => {
    navigate({
      pathname: `/p/${projectId}/deliveries`,
      search: params.toString(),
    });
    refocus();
  };
  return (
    <div className="space-y-6 p-4 md:p-6">
      <header>
        <h1 ref={heading} tabIndex={-1} className="font-logo text-2xl">
          Deliveries
        </h1>
        <p className="text-sm text-muted-foreground">
          Trace each message recipient from storage to wake, acknowledgement and
          work result. Reading this page never fetches or acknowledges a
          mailbox.
        </p>
      </header>
      <form
        aria-label="Delivery filters"
        className="flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          setFilter("id", search.trim());
        }}
      >
        <label className="grid gap-1 text-sm">
          Agent
          <select
            className="rounded border border-border bg-background p-2"
            value={filters.agent ?? ""}
            onChange={(event) => setFilter("agent", event.target.value)}
          >
            <option value="">All agents</option>
            {filters.agent &&
              !agents.data?.agents.some(
                (a) => a.agent.id === filters.agent,
              ) && <option value={filters.agent}>{filters.agent}</option>}
            {agents.data?.agents.map(({ agent }) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-sm">
          Room
          <select
            className="rounded border border-border bg-background p-2"
            value={filters.room ?? ""}
            onChange={(event) => setFilter("room", event.target.value)}
          >
            <option value="">All rooms</option>
            {filters.room &&
              !rooms.data?.rooms.some((r) => r.id === filters.room) && (
                <option value={filters.room}>{filters.room}</option>
              )}
            {rooms.data?.rooms.map((room) => (
              <option key={room.id} value={room.id}>
                {room.name}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-sm">
          State
          <select
            className="rounded border border-border bg-background p-2"
            value={filters.state ?? ""}
            onChange={(event) => setFilter("state", event.target.value)}
          >
            <option value="">Any state</option>
            {STATES.map((value) => (
              <option key={value} value={value}>
                {STATE_LABEL[value]}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-sm">
          Message or delivery ID
          <input
            className="w-80 max-w-full rounded border border-border bg-background p-2 font-mono"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Optional UUID"
            pattern="[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
          />
        </label>
        <Button type="submit" variant="outline">
          Search
        </Button>
        {filtered && (
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setSearch("");
              setParams(new URLSearchParams(), { replace: true });
            }}
          >
            Clear filters
          </Button>
        )}
      </form>
      {(filters.wake || filters.expires_after !== undefined) && (
        <div className="flex flex-wrap items-center gap-1.5">
          {filters.wake && (
            <FilterChip
              label="wake: suppressed until resumed"
              remove="Remove wake filter"
              onRemove={() => setFilter("wake", "")}
            />
          )}
          {filters.expires_after !== undefined && (
            <FilterChip
              label={`expired after ${formatDateTime(filters.expires_after)}`}
              remove="Remove expiry filter"
              onRemove={() => setFilter("expires_after", "")}
            />
          )}
        </div>
      )}
      {unavailable && (
        <div className="rounded-md border border-border p-4 text-sm">
          <p>Conversations are not set up in this project yet.</p>
          <p className="text-muted-foreground">
            Deliveries exist once a registered agent is a member of a room.
            Register one with{" "}
            <code className="font-mono">tila agent register</code>, create a
            room with <code className="font-mono">tila room create</code>, then
            add the agent as a member.
          </p>
        </div>
      )}
      <QuerySection
        state={deriveSectionState(deliveries, {
          isEmpty: (data) => data.pages.every((p) => p.deliveries.length === 0),
        })}
        label="deliveries"
        empty={
          filtered
            ? "No deliveries match these filters."
            : "No deliveries recorded yet."
        }
        onRetry={() => void deliveries.refetch()}
        forbidden="Browsing deliveries requires conversation management (maintainer role or conversations:manage). Room readers can see delivery counts on each message in Rooms."
      >
        {() => (
          <div className="space-y-3">
            {total !== undefined && (
              <p className="font-mono text-[11px] text-fg-faint">
                {total.toLocaleString("en-US")}{" "}
                {total === 1 ? "delivery matches" : "deliveries match"}
              </p>
            )}
            <div className="overflow-x-auto rounded-lg border border-border">
              <table
                className="w-full text-left text-sm"
                aria-label="Deliveries"
              >
                <thead className="bg-card">
                  <tr>
                    {[
                      "Message",
                      "Recipient",
                      "Wake",
                      "Fetched",
                      "Acknowledged",
                      "Work result",
                      "",
                    ].map((label) => (
                      <th key={label || "actions"} className="p-3">
                        {label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <DeliveryRow
                      key={row.delivery.id}
                      project={project}
                      row={row}
                      search={params.toString()}
                      onOpen={(element) => {
                        returnFocus.current = element;
                      }}
                    />
                  ))}
                </tbody>
              </table>
            </div>
            {deliveries.hasNextPage && (
              <Button
                variant="outline"
                size="sm"
                disabled={deliveries.isFetchingNextPage}
                onClick={() => void deliveries.fetchNextPage()}
              >
                {deliveries.isFetchingNextPage ? "Loading…" : "Load more"}
              </Button>
            )}
          </div>
        )}
      </QuerySection>
      {projectId && agentId && deliveryId && (
        <Drawer title="Delivery trace" onClose={close} restoreFocus={refocus}>
          <DeliveryDetail
            project={projectId}
            agent={agentId}
            delivery={deliveryId}
          />
        </Drawer>
      )}
    </div>
  );
}

function DeliveryRow({
  project,
  row,
  search,
  onOpen,
}: {
  project: string;
  row: DeliveryTraceItem;
  search: string;
  onOpen: (element: HTMLElement) => void;
}) {
  const { delivery, message, trace } = row;
  const wake = wakeLabel(trace.wake);
  const [ack, ackTone] = ackLabel(trace);
  return (
    <tr className="border-t border-border align-top">
      <th scope="row" className="p-3 font-normal">
        <span className="block">
          {message.room_id} · #{message.seq}
        </span>
        <span className="block text-xs text-muted-foreground">
          {new Date(trace.stored.at).toLocaleString()}
          {message.thread_id && " · in thread"}
        </span>
      </th>
      <td className="p-3">
        <span className="block">{delivery.agent_id}</span>
        <TraceBadges trace={trace} />
      </td>
      <td className="p-3">
        <Badge variant={wake.tone}>{wake.label}</Badge>
        {trace.wake.attempts > 1 && (
          <span className="block text-xs text-muted-foreground">
            {trace.wake.attempts} attempts
          </span>
        )}
      </td>
      <td className="p-3">
        <Badge variant={trace.fetched ? "green" : "gray"}>
          {trace.fetched ? "Fetched" : "Not fetched"}
        </Badge>
      </td>
      <td className="p-3">
        <Badge variant={ackTone}>{ack}</Badge>
      </td>
      <td className="p-3">
        <WorkResultBadge result={trace.work_result} />
      </td>
      <td className="p-3">
        <Link
          className="text-signal-blue underline"
          to={{
            pathname: `/p/${project}/deliveries/${encodeURIComponent(delivery.agent_id)}/${encodeURIComponent(delivery.id)}`,
            search,
          }}
          onClick={(event) => onOpen(event.currentTarget)}
          aria-label={`Trace delivery to ${delivery.agent_id} for message ${message.seq}`}
        >
          Trace
        </Link>
      </td>
    </tr>
  );
}
