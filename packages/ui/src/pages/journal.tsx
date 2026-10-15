import { JournalHistoryControl } from "@/components/journal-history-control";
import {
  JournalReportForm,
  ProjectReportDetails,
} from "@/components/journal-report";
import { AuthorAffix } from "@/components/ui/author-affix";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MultiSelectFilter } from "@/components/ui/multi-select-filter";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { TableError } from "@/components/ui/table-error";
import { useAuth } from "@/hooks/use-auth";
import { useDebouncedValue } from "@/hooks/use-debounce";
import { useJournalHistory } from "@/hooks/use-journal-history";
import { listJournal } from "@/lib/api";
import { hasActiveFilters } from "@/lib/journal-history";
import { formatTime } from "@/lib/time";
import { useQuery } from "@tanstack/react-query";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";

const MAX_ROWS = 500;
const PRUNE_COUNT = 100;
const PAGE_SIZE = 100;

const SOURCE_OPTIONS = ["cli", "sdk", "mcp", "dashboard"];

import type { FilterGroup } from "@/components/ui/multi-select-filter";

const KIND_GROUPS: FilterGroup[] = [
  {
    label: "Task",
    options: [
      "entity.created",
      "entity.updated",
      "entity.archived",
      "entity.artifact.referenced",
    ],
  },
  {
    label: "Claim",
    options: ["claim.acquired", "claim.renewed", "claim.released"],
  },
  {
    label: "Artifact",
    options: [
      "artifact.produced",
      "artifact.expired",
      "artifact.tombstoned",
      "artifact.reconciled",
      "artifact.search.rebuilt",
      "artifact.relationship.added",
    ],
  },
  {
    label: "Gate",
    options: [
      "gate.created",
      "gate.resolved",
      "gate.timed_out",
      "gate.cancelled",
    ],
  },
  {
    label: "Settings",
    options: [
      "agent.registered",
      "agent.updated",
      "agent.archived",
      "agent.unarchived",
      "room.created",
      "room.updated",
      "room.members_changed",
      "room.archived",
      "room.unarchived",
      "signal_group.created",
      "signal_group.updated",
      "signal_group.deleted",
    ],
  },
  {
    label: "Other",
    options: [
      "schema.applied",
      "custom.reported",
      "template.instantiated",
      "record.created",
      "record.updated",
      "record.archived",
      "record.unarchived",
    ],
  },
];

const KIND_OPTIONS = KIND_GROUPS.flatMap((g) => g.options);

/**
 * A journal read: without a cursor the API returns the newest page newest
 * first; with `after_seq` it returns the next page oldest first. The table is a
 * chronological tail, so rows are always held and shown in ascending seq order.
 * `archived` reports that the cursor sits below the archive watermark, so the
 * live table holds no rows for that range.
 */
type JournalListPage = {
  events: JournalEvent[];
  archived?: boolean;
  lastArchivedSeq?: number | null;
};

const bySeq = (a: { seq: number }, b: { seq: number }) => a.seq - b.seq;

type JournalEvent = {
  seq: number;
  t: number;
  kind: string;
  resource: string;
  principal_id: string;
  participant_id: string;
  environment: {
    machine?: string;
    client_name?: string;
    client_version?: string;
  };
  token_id: string | null;
  fence: number | null;
  data: Record<string, unknown>;
};

function kindBadgeVariant(kind: string): "default" | "green" | "amber" | "red" {
  const verb = kind.split(".").pop() ?? "";
  switch (verb) {
    case "created":
    case "produced":
    case "instantiated":
    case "applied":
    case "added":
    case "referenced":
      return "green";
    case "acquired":
      return "amber";
    case "archived":
    case "released":
    case "expired":
    case "tombstoned":
    case "timed_out":
    case "cancelled":
      return "red";
    default:
      return "default";
  }
}

function ResourceLink({
  resource,
  kind,
  data,
  projectId,
}: {
  resource: string;
  kind: string;
  data: Record<string, unknown>;
  projectId: string | null;
}) {
  const prefix = kind.split(".")[0] ?? "";
  const display =
    resource.length > 30 ? `${resource.slice(0, 30)}...` : resource;
  const p = projectId ? `/p/${projectId}` : "";

  if (prefix === "entity" || prefix === "gate") {
    return (
      <Link
        to={`${p}/tasks/${resource}`}
        className="text-signal-blue hover:text-signal-blue-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal-blue rounded-sm"
      >
        {display}
      </Link>
    );
  }

  if (prefix === "claim") {
    const cleaned = resource.startsWith("task:") ? resource.slice(5) : resource;
    return (
      <Link
        to={`${p}/tasks/${cleaned}`}
        className="text-signal-blue hover:text-signal-blue-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal-blue rounded-sm"
      >
        {display}
      </Link>
    );
  }

  if (prefix === "artifact") {
    const r2Key =
      typeof data.r2_key === "string"
        ? data.r2_key
        : typeof data.key === "string"
          ? data.key
          : null;
    const taskResource =
      typeof data.resource === "string" && data.resource.startsWith("task:")
        ? data.resource.slice(5)
        : null;
    return (
      <span>
        {r2Key ? (
          <Link
            to={`${p}/artifacts/${r2Key}`}
            className="text-signal-blue hover:text-signal-blue-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal-blue rounded-sm"
          >
            {display}
          </Link>
        ) : (
          <span>{display}</span>
        )}
        {taskResource && (
          <>
            {" "}
            <Link
              to={`${p}/tasks/${taskResource}`}
              className="text-signal-blue hover:text-signal-blue-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal-blue rounded-sm"
              title="View task"
            >
              {"↗"}
            </Link>
          </>
        )}
      </span>
    );
  }

  return <span className="text-foreground">{display}</span>;
}

function mapSourceToAffix(
  source: string | null,
): "agent" | "cli" | "user" | "sys" {
  switch (source) {
    case "cli":
      return "cli";
    case "sdk":
    case "mcp":
      return "agent";
    case "dashboard":
      return "user";
    default:
      return "sys";
  }
}

// Memoized: the table can hold the live tail plus a buffer of older history,
// and a tail poll or a history load should not re-render rows it did not touch.
const EventRow = memo(function EventRow({ event }: { event: JournalEvent }) {
  const { projectId } = useAuth();
  const [dataOpen, setDataOpen] = useState(false);
  const hasData = event.data && Object.keys(event.data).length > 0;

  return (
    <>
      <TableRow>
        <TableCell className="tila-num text-muted-foreground">
          #{event.seq}
        </TableCell>
        <TableCell className="tila-num text-muted-foreground">
          {formatTime(event.t)}
        </TableCell>
        <TableCell>
          {event.kind === "custom.reported" ? (
            <ProjectReportDetails data={event.data} projectId={projectId} />
          ) : (
            <Badge variant={kindBadgeVariant(event.kind)}>{event.kind}</Badge>
          )}
        </TableCell>
        <TableCell>
          {event.kind === "custom.reported" ? (
            <span>{event.resource}</span>
          ) : (
            <ResourceLink
              resource={event.resource}
              kind={event.kind}
              data={event.data}
              projectId={projectId}
            />
          )}
        </TableCell>
        <TableCell className="text-muted-foreground">
          {event.kind === "custom.reported" && <span>Reporter: </span>}
          <span className="inline-flex items-center gap-1.5">
            {event.principal_id}/{event.participant_id}
            <AuthorAffix
              source={mapSourceToAffix(event.environment.client_name ?? null)}
            />
          </span>
        </TableCell>
        <TableCell>
          {hasData && (
            <Button
              variant="ghost"
              size="xs"
              onClick={() => setDataOpen((v) => !v)}
              aria-expanded={dataOpen}
              aria-label={`Toggle data for event #${event.seq}`}
            >
              data
            </Button>
          )}
        </TableCell>
      </TableRow>
      {hasData && dataOpen && (
        <TableRow>
          <TableCell colSpan={6} className="p-0">
            <pre className="overflow-x-auto bg-card p-2 text-xs text-foreground whitespace-pre-wrap break-all">
              {JSON.stringify(event.data, null, 2)}
            </pre>
          </TableCell>
        </TableRow>
      )}
    </>
  );
});

export function JournalPage() {
  const { projectId } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();

  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (
        e.key === "/" &&
        !e.ctrlKey &&
        !e.metaKey &&
        document.activeElement?.tagName !== "INPUT" &&
        document.activeElement?.tagName !== "TEXTAREA"
      ) {
        e.preventDefault();
        searchRef.current?.focus();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  const [resourceInput, setResourceInput] = useState(
    () => searchParams.get("resource") ?? "",
  );
  const [kindFilter, setKindFilter] = useState<string[]>(
    () => searchParams.get("kind")?.split(",").filter(Boolean) ?? [],
  );
  const [clientNameFilter, setClientNameFilter] = useState<string[]>(
    () => searchParams.get("client_name")?.split(",").filter(Boolean) ?? [],
  );
  const [eventName, setEventName] = useState(
    () => searchParams.get("event_name") ?? "",
  );
  const [correlation, setCorrelation] = useState(
    () => searchParams.get("correlation_id") ?? "",
  );
  const filterEventName = useDebouncedValue(eventName, 300);
  const filterCorrelation = useDebouncedValue(correlation, 300);
  const filterResource = useDebouncedValue(resourceInput, 300);
  const filterKind = kindFilter;
  const filterClientName = clientNameFilter;

  // Events accumulator in React state (state-driven rendering, no manual tick)
  const [events, setEvents] = useState<JournalEvent[]>([]);
  // Cursor lives entirely in the ref (read in the tail queryFn, not in any
  // queryKey per OQ-5); renders are driven by setEvents, so no cursor state.
  const lastSeqRef = useRef(0);
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    const params = new URLSearchParams();
    if (filterEventName) params.set("event_name", filterEventName);
    if (filterCorrelation) params.set("correlation_id", filterCorrelation);
    if (filterResource) params.set("resource", filterResource);
    if (filterKind.length > 0) params.set("kind", filterKind.join(","));
    if (filterClientName.length > 0)
      params.set("client_name", filterClientName.join(","));
    setSearchParams(params, { replace: true });
  }, [
    filterResource,
    filterKind,
    filterClientName,
    filterEventName,
    filterCorrelation,
    setSearchParams,
  ]);

  // Scroll tracking
  const scrollRef = useRef<HTMLDivElement>(null);
  const wasAtBottomRef = useRef(true);

  const isAtBottom = useCallback((): boolean => {
    const el = scrollRef.current;
    if (!el) return true;
    return el.scrollTop + el.clientHeight >= el.scrollHeight - 40;
  }, []);

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  // Initial query — seeds events; retryKey bump re-triggers on retry
  const initialQuery = useQuery({
    queryKey: [
      "journal-initial",
      projectId,
      filterResource,
      filterKind,
      filterClientName,
      filterEventName,
      filterCorrelation,
      retryKey,
    ],
    queryFn: async (): Promise<JournalListPage> => {
      const params: {
        event_name?: string;
        correlation_id?: string;
        resource?: string;
        kind?: string[];
        client_name?: string[];
        limit: number;
      } = { limit: PAGE_SIZE };
      if (filterEventName) params.event_name = filterEventName;
      if (filterCorrelation) params.correlation_id = filterCorrelation;
      if (filterResource) params.resource = filterResource;
      if (filterKind.length > 0) params.kind = filterKind;
      if (filterClientName.length > 0) params.client_name = filterClientName;
      if (!projectId) return { events: [] };
      return listJournal(projectId, params) as Promise<JournalListPage>;
    },
    enabled: Boolean(projectId),
    staleTime: Number.POSITIVE_INFINITY,
  });

  // Seed events from initial query result. The API returns the newest page
  // newest-first; the table reads oldest to newest, ending at the latest event.
  useEffect(() => {
    if (!initialQuery.data) return;
    const loaded = [...initialQuery.data.events].sort(bySeq);
    setEvents(loaded);
    const maxSeq = loaded.length > 0 ? loaded[loaded.length - 1].seq : 0;
    lastSeqRef.current = maxSeq;
    requestAnimationFrame(() => scrollToBottom());
  }, [initialQuery.data, scrollToBottom]);

  // Tail query — reads lastSeqRef.current (NOT in queryKey per OQ-5)
  const tailQuery = useQuery({
    queryKey: [
      "journal-tail",
      projectId,
      filterResource,
      filterKind,
      filterClientName,
      filterEventName,
      filterCorrelation,
    ],
    queryFn: async (): Promise<JournalListPage> => {
      const params: {
        event_name?: string;
        correlation_id?: string;
        resource?: string;
        kind?: string[];
        client_name?: string[];
        after_seq: number;
        limit: number;
      } = { after_seq: lastSeqRef.current, limit: PAGE_SIZE };
      if (filterEventName) params.event_name = filterEventName;
      if (filterCorrelation) params.correlation_id = filterCorrelation;
      if (filterResource) params.resource = filterResource;
      if (filterKind.length > 0) params.kind = filterKind;
      if (filterClientName.length > 0) params.client_name = filterClientName;
      if (!projectId) return { events: [] };
      return listJournal(projectId, params) as Promise<JournalListPage>;
    },
    enabled: Boolean(projectId) && initialQuery.isSuccess,
    refetchInterval: 3000,
    staleTime: 0,
  });

  const refetchTail = tailQuery.refetch;

  // Append tail events to accumulator
  useEffect(() => {
    // RC-4: guard — tailQuery.data is undefined on first render after enabled flips
    const page = tailQuery.data;
    if (!page) return;
    // A cursor below the archive watermark reads as an empty, archived page.
    // The tail shows live rows only, so skip past the archived range and read
    // again instead of polling a range that can never yield rows.
    if (
      page.archived &&
      typeof page.lastArchivedSeq === "number" &&
      page.lastArchivedSeq > lastSeqRef.current
    ) {
      lastSeqRef.current = page.lastArchivedSeq;
      void refetchTail();
      return;
    }
    if (page.events.length === 0) return;
    const incoming = page.events;
    const previousSeq = lastSeqRef.current;
    wasAtBottomRef.current = isAtBottom();
    setEvents((prev) => {
      const existingSeqs = new Set(prev.map((e) => e.seq));
      const fresh = incoming.filter((e) => !existingSeqs.has(e.seq));
      if (fresh.length === 0) return prev;
      const merged = [...prev, ...fresh].sort(bySeq);
      return merged.length > MAX_ROWS ? merged.slice(PRUNE_COUNT) : merged;
    });
    lastSeqRef.current = Math.max(
      lastSeqRef.current,
      ...incoming.map((e) => e.seq),
    );
    if (wasAtBottomRef.current) {
      requestAnimationFrame(() => scrollToBottom());
    }
    // A full page means more rows may be waiting after the cursor: drain the
    // burst now rather than one page per poll interval. The cursor must have
    // advanced, so a server that ignores it cannot spin this loop.
    if (incoming.length >= PAGE_SIZE && lastSeqRef.current > previousSeq) {
      void refetchTail();
    }
  }, [tailQuery.data, scrollToBottom, isAtBottom, refetchTail]);

  // Older history is read through replay into a buffer of its own. It shares
  // the filters with the tail and nothing else: `lastSeqRef` is read once, to
  // learn where the live view begins, and no history load ever writes it, so
  // the tail's cursor, prune and archive-skip logic above are unaffected.
  const historyFilters = useMemo(
    () => ({
      resource: filterResource,
      kind: filterKind,
      clientName: filterClientName,
      eventName: filterEventName,
      correlationId: filterCorrelation,
    }),
    [
      filterResource,
      filterKind,
      filterClientName,
      filterEventName,
      filterCorrelation,
    ],
  );
  const history = useJournalHistory({
    projectId,
    filters: historyFilters,
    readAnchor: () =>
      events.length > 0
        ? { seq: events[0].seq, fromRow: true }
        : { seq: lastSeqRef.current + 1, fromRow: false },
  });
  const liveLow = events.length > 0 ? events[0].seq : null;
  // History sits below the live view; a row the tail now shows is not repeated.
  const historyRows = useMemo(
    () =>
      liveLow === null
        ? history.rows
        : history.rows.filter((row) => row.seq < liveLow),
    [history.rows, liveLow],
  );
  // The tail prunes (or reseeds) independently, so its first row can move past
  // where history began. Say so rather than show a silent hole.
  const historyGap =
    history.anchor?.fromRow && liveLow !== null && liveLow > history.anchor.seq
      ? { from: history.anchor.seq, through: liveLow - 1 }
      : null;

  const loadError = initialQuery.isError ? initialQuery.error : null;
  const initialLoaded = initialQuery.isSuccess;

  const clearFilters = useCallback(() => {
    setEventName("");
    setCorrelation("");
    setResourceInput("");
    setKindFilter([]);
    setClientNameFilter([]);
  }, []);

  const [showJumpBtn, setShowJumpBtn] = useState(false);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    function onScroll() {
      if (!el) return;
      const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 40;
      setShowJumpBtn(!atBottom);
    }
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <div className="flex h-[calc(100dvh-57px)] flex-col gap-4 p-3 md:p-6">
      <h1 className="font-logo text-xl tracking-tight text-foreground">
        Journal
      </h1>
      {projectId && (
        <JournalReportForm
          key={projectId}
          projectId={projectId}
          onAccepted={() => setRetryKey((key) => key + 1)}
        />
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Input
          aria-label="Filter journal by event name"
          placeholder="Custom event name"
          value={eventName}
          onChange={(e) => setEventName(e.target.value)}
          className="w-52"
        />
        <Input
          aria-label="Filter journal by correlation ID"
          placeholder="Correlation ID"
          value={correlation}
          onChange={(e) => setCorrelation(e.target.value)}
          className="w-52"
        />
        <Input
          ref={searchRef}
          type="text"
          placeholder="Filter by resource..."
          aria-label="Filter journal by resource"
          value={resourceInput}
          onChange={(e) => setResourceInput(e.target.value)}
          className="w-52"
        />
        <MultiSelectFilter
          label="Kind"
          options={KIND_OPTIONS}
          selected={kindFilter}
          onChange={setKindFilter}
          groups={KIND_GROUPS}
        />
        <MultiSelectFilter
          label="Client"
          options={SOURCE_OPTIONS}
          selected={clientNameFilter}
          onChange={setClientNameFilter}
        />
        {(eventName ||
          correlation ||
          resourceInput ||
          kindFilter.length > 0 ||
          clientNameFilter.length > 0) && (
          <Button variant="ghost" size="sm" onClick={clearFilters}>
            Reset
          </Button>
        )}
      </div>

      {(filterResource ||
        kindFilter.length > 0 ||
        clientNameFilter.length > 0) && (
        <div className="flex flex-wrap items-center gap-1.5">
          {filterResource && (
            <span className="inline-flex items-center gap-1 rounded-full bg-tint-blue-08 px-2.5 py-0.5 font-mono text-[11px] text-signal-blue">
              resource: {filterResource}
              <button
                type="button"
                onClick={() => setResourceInput("")}
                className="flex size-7 cursor-pointer items-center justify-center rounded-sm text-muted-foreground hover:text-foreground"
                aria-label="Remove resource filter"
              >
                <svg
                  width="10"
                  height="10"
                  viewBox="0 0 10 10"
                  aria-hidden="true"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                >
                  <path d="M1.5 1.5L8.5 8.5M8.5 1.5L1.5 8.5" />
                </svg>
              </button>
            </span>
          )}
          {kindFilter.map((k) => (
            <span
              key={k}
              className="inline-flex items-center gap-1 rounded-full bg-tint-blue-08 px-2.5 py-0.5 font-mono text-[11px] text-signal-blue"
            >
              kind: {k}
              <button
                type="button"
                onClick={() =>
                  setKindFilter((prev) => prev.filter((x) => x !== k))
                }
                className="flex size-7 cursor-pointer items-center justify-center rounded-sm text-muted-foreground hover:text-foreground"
                aria-label={`Remove kind filter: ${k}`}
              >
                <svg
                  width="10"
                  height="10"
                  viewBox="0 0 10 10"
                  aria-hidden="true"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                >
                  <path d="M1.5 1.5L8.5 8.5M8.5 1.5L1.5 8.5" />
                </svg>
              </button>
            </span>
          ))}
          {clientNameFilter.map((s) => (
            <span
              key={s}
              className="inline-flex items-center gap-1 rounded-full bg-tint-blue-08 px-2.5 py-0.5 font-mono text-[11px] text-signal-blue"
            >
              client: {s}
              <button
                type="button"
                onClick={() =>
                  setClientNameFilter((prev) => prev.filter((x) => x !== s))
                }
                className="flex size-7 cursor-pointer items-center justify-center rounded-sm text-muted-foreground hover:text-foreground"
                aria-label={`Remove client filter: ${s}`}
              >
                <svg
                  width="10"
                  height="10"
                  viewBox="0 0 10 10"
                  aria-hidden="true"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                >
                  <path d="M1.5 1.5L8.5 8.5M8.5 1.5L1.5 8.5" />
                </svg>
              </button>
            </span>
          ))}
        </div>
      )}

      {projectId && initialLoaded && !loadError && (
        <JournalHistoryControl
          history={history}
          filtered={hasActiveFilters(historyFilters)}
          gap={historyGap}
        />
      )}

      <div
        ref={scrollRef}
        className="relative flex-1 overflow-y-auto border-t border-border"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: scroll container needs focus for keyboard scrolling
        tabIndex={0}
        role="log"
        aria-label="Journal events"
      >
        {loadError ? (
          <TableError
            error={loadError}
            onRetry={() => {
              setRetryKey((k) => k + 1);
            }}
          />
        ) : events.length === 0 && historyRows.length === 0 ? (
          <p className="p-4 text-muted-foreground">
            {initialLoaded
              ? "No journal events match the current filters. Events stream in real-time as agents operate."
              : "Loading..."}
          </p>
        ) : (
          <Table aria-label="Journal">
            <TableHeader>
              <TableRow>
                <TableHead title="Event sequence number">Seq</TableHead>
                <TableHead title="Server-recorded event time">
                  Recorded
                </TableHead>
                <TableHead title="Event type">Kind</TableHead>
                <TableHead title="Affected task or artifact">
                  Resource
                </TableHead>
                <TableHead title="Agent or token that triggered this event">
                  Actor
                </TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {historyRows.map((event) => (
                <EventRow key={event.seq} event={event} />
              ))}
              {events.map((event) => (
                <EventRow key={event.seq} event={event} />
              ))}
            </TableBody>
          </Table>
        )}
        {events.length > 0 && (
          <p
            className="px-3 py-1.5 text-[10px] text-fg-faint"
            aria-hidden="true"
          >
            <kbd className="font-mono">/</kbd> filter{" "}
            <kbd className="font-mono">⌘K</kbd> search
          </p>
        )}
        {events.length >= MAX_ROWS - PRUNE_COUNT && (
          <p className="px-3 py-1.5 text-center font-mono text-[11px] text-fg-faint">
            Showing latest {events.length} events.{" "}
            {history.restricted
              ? "Older events are trimmed automatically."
              : "The live view trims older events automatically; Load older reads them back from history."}
          </p>
        )}
        {showJumpBtn && (
          <button
            type="button"
            onClick={scrollToBottom}
            className="absolute bottom-4 right-6 cursor-pointer rounded-md bg-card px-3 py-1.5 font-mono text-xs text-muted-foreground shadow-[var(--shadow-overlay)] hover:text-foreground"
          >
            Jump to latest
          </button>
        )}
      </div>
    </div>
  );
}
