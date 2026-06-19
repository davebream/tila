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
import { listJournal } from "@/lib/api";
import { formatTime } from "@/lib/time";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";

const MAX_ROWS = 500;
const PRUNE_COUNT = 100;

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
    label: "Other",
    options: [
      "schema.applied",
      "template.instantiated",
      "record.created",
      "record.updated",
      "record.archived",
      "record.unarchived",
    ],
  },
];

const KIND_OPTIONS = KIND_GROUPS.flatMap((g) => g.options);

type JournalEvent = {
  seq: number;
  t: number;
  kind: string;
  resource: string;
  actor: string;
  fence: number | null;
  data: Record<string, unknown>;
  source: string | null;
  source_version: string | null;
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

function EventRow({ event }: { event: JournalEvent }) {
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
          <Badge variant={kindBadgeVariant(event.kind)}>{event.kind}</Badge>
        </TableCell>
        <TableCell>
          <ResourceLink
            resource={event.resource}
            kind={event.kind}
            data={event.data}
            projectId={projectId}
          />
        </TableCell>
        <TableCell className="text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            {event.actor}
            <AuthorAffix source={mapSourceToAffix(event.source)} />
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
}

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
  const [sourceFilter, setSourceFilter] = useState<string[]>(
    () => searchParams.get("source")?.split(",").filter(Boolean) ?? [],
  );
  const filterResource = useDebouncedValue(resourceInput, 300);
  const filterKind = kindFilter;
  const filterSource = sourceFilter;

  // Events accumulator in React state (state-driven rendering, no manual tick)
  const [events, setEvents] = useState<JournalEvent[]>([]);
  const [lastSeq, setLastSeq] = useState(0);
  const lastSeqRef = useRef(0);
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    const params = new URLSearchParams();
    if (filterResource) params.set("resource", filterResource);
    if (filterKind.length > 0) params.set("kind", filterKind.join(","));
    if (filterSource.length > 0) params.set("source", filterSource.join(","));
    setSearchParams(params, { replace: true });
  }, [filterResource, filterKind, filterSource, setSearchParams]);

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
      filterSource,
      retryKey,
    ],
    queryFn: async () => {
      const params: {
        resource?: string;
        kind?: string[];
        source?: string[];
        limit: number;
      } = { limit: 100 };
      if (filterResource) params.resource = filterResource;
      if (filterKind.length > 0) params.kind = filterKind;
      if (filterSource.length > 0) params.source = filterSource;
      if (!projectId) return { events: [] as JournalEvent[] };
      return listJournal(projectId, params) as Promise<{
        events: JournalEvent[];
      }>;
    },
    enabled: Boolean(projectId),
    staleTime: Number.POSITIVE_INFINITY,
  });

  // Seed events from initial query result
  useEffect(() => {
    if (!initialQuery.data) return;
    const loaded = initialQuery.data.events;
    setEvents(loaded);
    const maxSeq =
      loaded.length > 0 ? Math.max(...loaded.map((e) => e.seq)) : 0;
    // Assign ref BEFORE state (RC-4: ref must be current before next render)
    lastSeqRef.current = maxSeq;
    setLastSeq(maxSeq);
    requestAnimationFrame(() => scrollToBottom());
  }, [initialQuery.data, scrollToBottom]);

  // Tail query — reads lastSeqRef.current (NOT in queryKey per OQ-5)
  const tailQuery = useQuery({
    queryKey: [
      "journal-tail",
      projectId,
      filterResource,
      filterKind,
      filterSource,
    ],
    queryFn: async () => {
      const params: {
        resource?: string;
        kind?: string[];
        source?: string[];
        after_seq: number;
        limit: number;
      } = { after_seq: lastSeqRef.current, limit: 100 };
      if (filterResource) params.resource = filterResource;
      if (filterKind.length > 0) params.kind = filterKind;
      if (filterSource.length > 0) params.source = filterSource;
      if (!projectId) return { events: [] as JournalEvent[] };
      return listJournal(projectId, params) as Promise<{
        events: JournalEvent[];
      }>;
    },
    enabled: Boolean(projectId) && initialQuery.isSuccess,
    refetchInterval: 3000,
    staleTime: 0,
  });

  // Append tail events to accumulator
  useEffect(() => {
    // RC-4: guard — tailQuery.data is undefined on first render after enabled flips
    if (!tailQuery.data || tailQuery.data.events.length === 0) return;
    const incoming = tailQuery.data.events;
    wasAtBottomRef.current = isAtBottom();
    setEvents((prev) => {
      const existingSeqs = new Set(prev.map((e) => e.seq));
      const fresh = incoming.filter((e) => !existingSeqs.has(e.seq));
      if (fresh.length === 0) return prev;
      const merged = [...prev, ...fresh];
      return merged.length > MAX_ROWS ? merged.slice(PRUNE_COUNT) : merged;
    });
    const next = Math.max(lastSeqRef.current, ...incoming.map((e) => e.seq));
    lastSeqRef.current = next;
    setLastSeq(next);
    if (wasAtBottomRef.current) {
      requestAnimationFrame(() => scrollToBottom());
    }
  }, [tailQuery.data, scrollToBottom, isAtBottom]);

  const loadError = initialQuery.isError ? initialQuery.error : null;
  const initialLoaded = initialQuery.isSuccess;
  // lastSeq used to suppress unused-variable lint (cursor drives ref; state for re-render)
  void lastSeq;

  const clearFilters = useCallback(() => {
    setResourceInput("");
    setKindFilter([]);
    setSourceFilter([]);
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

      <div className="flex flex-wrap items-center gap-2">
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
          label="Source"
          options={SOURCE_OPTIONS}
          selected={sourceFilter}
          onChange={setSourceFilter}
        />
        {(resourceInput ||
          kindFilter.length > 0 ||
          sourceFilter.length > 0) && (
          <Button variant="ghost" size="sm" onClick={clearFilters}>
            Reset
          </Button>
        )}
      </div>

      {(filterResource || kindFilter.length > 0 || sourceFilter.length > 0) && (
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
          {sourceFilter.map((s) => (
            <span
              key={s}
              className="inline-flex items-center gap-1 rounded-full bg-tint-blue-08 px-2.5 py-0.5 font-mono text-[11px] text-signal-blue"
            >
              source: {s}
              <button
                type="button"
                onClick={() =>
                  setSourceFilter((prev) => prev.filter((x) => x !== s))
                }
                className="flex size-7 cursor-pointer items-center justify-center rounded-sm text-muted-foreground hover:text-foreground"
                aria-label={`Remove source filter: ${s}`}
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
        ) : events.length === 0 ? (
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
                <TableHead title="Event timestamp">Time</TableHead>
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
            Showing latest {events.length} events. Older events are trimmed
            automatically.
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
