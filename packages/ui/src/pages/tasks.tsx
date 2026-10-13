import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { CopyButton } from "@/components/ui/copy-button";
import { Input } from "@/components/ui/input";
import { LastRefreshed } from "@/components/ui/last-refreshed";
import {
  type FilterGroup,
  MultiSelectFilter,
} from "@/components/ui/multi-select-filter";
import { PageNav } from "@/components/ui/page-nav";
import { SectionFailure } from "@/components/ui/query-section";
import { SortableHead } from "@/components/ui/sortable-head";
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
import { NewTaskLink } from "@/components/work/create-links";
import {
  TASK_SEARCH_MIN_LENGTH,
  useTaskPage,
  useTaskSearch,
  useWorkCatalog,
} from "@/hooks/use-api";
import { useAuth } from "@/hooks/use-auth";
import {
  CURSOR_RESET_NOTICE,
  pagePosition,
  useCursorPaging,
  useDropInvalidCursor,
} from "@/hooks/use-cursor-paging";
import { useDebouncedValue } from "@/hooks/use-debounce";
import { useTableKeyNav } from "@/hooks/use-table-key-nav";
import { useTimeTick } from "@/hooks/use-time-tick";
import type { TaskListSort } from "@/lib/api";
import { taskFiltersFromSearch } from "@/lib/list-queries";
import { catalogIndex, taskState, taskTitle } from "@/lib/presentation";
import { classifyApiError } from "@/lib/query-state";
import { sanitizeSnippet } from "@/lib/snippet";
import { relativeTime } from "@/lib/time";
import type { WorkCatalogEntry } from "@tila/schemas";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  Link,
  useLocation,
  useMatch,
  useNavigate,
  useSearchParams,
} from "react-router";

const PAGE_SIZE = 100;

type SortKey = "updated" | "type" | "id";
type Sort = { key: SortKey; dir: "asc" | "desc" };

const DEFAULT_SORT: Sort = { key: "updated", dir: "desc" };

const SORT_FIELDS: Record<SortKey, TaskListSort> = {
  updated: "updated_at",
  type: "type",
  id: "id",
};

function parseSort(raw: string | null): Sort | null {
  if (!raw) return null;
  const [k, d] = raw.split(":");
  if (
    (k === "updated" || k === "type" || k === "id") &&
    (d === "asc" || d === "desc")
  ) {
    return { key: k, dir: d };
  }
  return null;
}

function parseList(raw: string | null): string[] {
  return raw?.split(",").filter(Boolean) ?? [];
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

const linkClass =
  "rounded-sm text-signal-blue underline decoration-signal-blue/40 underline-offset-2 hover:text-signal-blue-hover hover:decoration-signal-blue focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal-blue";

function RemoveIcon() {
  return (
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
  );
}

function TypeCell({
  type,
  entry,
}: {
  type: string;
  entry: WorkCatalogEntry | undefined;
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <Badge variant="secondary">{type}</Badge>
      {entry?.declaration === "undeclared" && (
        <Badge
          variant="amber"
          title="The current schema does not declare this type"
        >
          Not in schema
        </Badge>
      )}
    </span>
  );
}

function Muted({ children }: { children: React.ReactNode }) {
  return <span className="text-muted-foreground">{children}</span>;
}

type Row = {
  id: string;
  type: string;
  title: string | null;
  data?: Record<string, unknown> | null;
  updated_at?: number;
  created_by?: string;
  snippet?: string | null;
};

export function TasksPage() {
  useTimeTick();
  const { projectId } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const detailMatch = useMatch(`/p/${projectId}/tasks/:id`);
  const selectedId = detailMatch?.params.id;
  const [searchParams, setSearchParams] = useSearchParams();

  const typeParam = searchParams.get("type");
  const typeFilter = useMemo(() => parseList(typeParam), [typeParam]);
  // Attention filters from Overview links; search cannot apply them.
  const { blocked, outcome } = taskFiltersFromSearch(searchParams);
  const urlQ = (searchParams.get("q") ?? "").trim();
  const sort = parseSort(searchParams.get("sort")) ?? DEFAULT_SORT;
  const includeArchived = searchParams.get("archived") === "1";
  const paging = useCursorPaging();
  const { after, cursorReset } = paging;

  const archivedId = useId();
  const searchMode = urlQ.length >= TASK_SEARCH_MIN_LENGTH;
  const shortQuery = urlQ.length > 0 && !searchMode;

  // Filter, sort, query and archived changes start again from page one.
  function updateParams(mutate: (p: URLSearchParams) => void) {
    paging.clearCursorReset();
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        mutate(next);
        next.delete("after");
        return next;
      },
      { replace: true },
    );
  }
  const updateParamsRef = useRef(updateParams);
  updateParamsRef.current = updateParams;

  // The input is local while typing; the URL follows after a short debounce.
  const [qInput, setQInput] = useState(urlQ);
  const debouncedQ = useDebouncedValue(qInput);
  const syncedQ = useRef(urlQ);
  useEffect(() => {
    // The URL changed from outside (e.g. the command palette): adopt it.
    if (urlQ !== syncedQ.current) {
      syncedQ.current = urlQ;
      setQInput(urlQ);
    }
  }, [urlQ]);
  useEffect(() => {
    const trimmed = debouncedQ.trim();
    if (trimmed === syncedQ.current) return;
    syncedQ.current = trimmed;
    updateParamsRef.current((p) => {
      if (trimmed) {
        p.set("q", trimmed);
        p.delete("blocked");
        p.delete("outcome");
      } else p.delete("q");
    });
  }, [debouncedQ]);

  function setTypeFilter(values: string[]) {
    updateParams((p) => {
      if (values.length > 0) p.set("type", values.join(","));
      else p.delete("type");
    });
  }

  function toggleSort(key: SortKey) {
    const next: Sort =
      sort.key === key
        ? { key, dir: sort.dir === "desc" ? "asc" : "desc" }
        : { key, dir: "desc" };
    updateParams((p) => {
      if (next.key === DEFAULT_SORT.key && next.dir === DEFAULT_SORT.dir) {
        p.delete("sort");
      } else {
        p.set("sort", `${next.key}:${next.dir}`);
      }
    });
  }

  function setIncludeArchived(include: boolean) {
    updateParams((p) => {
      if (include) p.set("archived", "1");
      else p.delete("archived");
    });
  }

  function resetFilters() {
    syncedQ.current = "";
    setQInput("");
    updateParams((p) => {
      p.delete("type");
      p.delete("q");
      p.delete("blocked");
      p.delete("outcome");
    });
  }

  function clearParam(key: "blocked" | "outcome") {
    updateParams((p) => p.delete(key));
  }

  // --- Data ---

  const catalogQuery = useWorkCatalog();
  const catalog = catalogQuery.data;
  const entries = useMemo(() => catalogIndex(catalog?.types), [catalog]);

  const listQuery = useTaskPage(
    {
      type: typeFilter,
      archived: includeArchived,
      blocked,
      outcome,
      sort: SORT_FIELDS[sort.key],
      order: sort.dir,
      limit: PAGE_SIZE,
      cursor: after,
    },
    { enabled: !searchMode },
  );
  const searchQuery = useTaskSearch(
    { q: urlQ, type: typeFilter, cursor: after, limit: PAGE_SIZE },
    { enabled: searchMode },
  );
  const active = searchMode ? searchQuery : listQuery;

  const invalidCursor = useDropInvalidCursor(active.error, paging);

  const rows: Row[] = useMemo(() => {
    if (searchMode) {
      return (searchQuery.data?.results ?? []).flatMap((r) =>
        r.type === "entity"
          ? [
              {
                id: r.entity_id,
                type: r.entity_type,
                title: r.name,
                snippet: r.snippet,
              },
            ]
          : [],
      );
    }
    return (listQuery.data?.entities ?? []).map((e) => ({
      id: e.id,
      type: e.type,
      title: taskTitle(e.data, entries.get(e.type)),
      data: e.data,
      updated_at: e.updated_at,
      created_by: e.created_by,
    }));
  }, [searchMode, searchQuery.data, listQuery.data, entries]);

  const nextCursor = searchMode
    ? (searchQuery.data?.next_cursor ?? null)
    : (listQuery.data?.next_cursor ?? null);

  // --- Type filter options: only from the catalog, never from rows ---

  const catalogLoaded = catalog !== undefined;
  // Selected types the catalog no longer lists (renamed, retired, or not
  // visible to this credential). They stay selected and are still sent.
  const missingTypes = useMemo(
    () => (catalogLoaded ? typeFilter.filter((t) => !entries.has(t)) : []),
    [catalogLoaded, typeFilter, entries],
  );
  const typeGroups: FilterGroup[] | undefined = useMemo(() => {
    if (!catalog) return undefined;
    const byDeclaration = (d: WorkCatalogEntry["declaration"]) =>
      catalog.types.filter((e) => e.declaration === d).map((e) => e.type);
    return [
      { label: "Declared", options: byDeclaration("declared") },
      { label: "Not in schema", options: byDeclaration("undeclared") },
      { label: "Definitions unavailable", options: byDeclaration("unknown") },
      { label: "Not available", options: missingTypes },
    ].filter((g) => g.options.length > 0);
  }, [catalog, missingTypes]);
  const typeOptions = typeGroups
    ? typeGroups.flatMap((g) => g.options)
    : typeFilter;
  const typeCount = (type: string) => {
    const entry = entries.get(type);
    if (!entry) return catalogLoaded ? "not available" : null;
    return includeArchived ? entry.count + entry.archived_count : entry.count;
  };

  const catalogTotal = catalog
    ? catalog.types.reduce((n, e) => n + e.count + e.archived_count, 0)
    : null;

  // --- Keyboard ---

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

  // The drawer opens over the same list page: keep the query string and the
  // page trail so closing it returns to exactly this page.
  const taskLink = (id: string) => ({
    pathname: `/p/${projectId}/tasks/${id}`,
    search: location.search,
  });
  const { focusIdx, handleKeyDown: handleTableKeyDown } = useTableKeyNav(
    rows.length,
    (idx) => navigate(taskLink(rows[idx].id), { state: location.state }),
  );

  // --- Copy ---

  const restricted = searchMode
    ? (searchQuery.data?.scope?.restricted ?? false)
    : (listQuery.data?.scope?.restricted ?? false);
  let summary: string | null = null;
  let position: string | null = null;
  if (searchMode && searchQuery.data) {
    summary = `${plural(rows.length, "result", "results")} · ranked by relevance · non-archived tasks${restricted ? " visible to this credential" : ""}`;
  } else if (!searchMode && listQuery.data) {
    const total = listQuery.data.total ?? rows.length;
    const archivedScope =
      listQuery.data.scope?.archived ??
      (includeArchived ? "included" : "excluded");
    const outcomeTypes = listQuery.data.scope?.outcome_types;
    const attention = [
      blocked ? "waiting on prerequisites" : null,
      outcome.length > 0
        ? `${outcome.join(" or ")} outcome${outcomeTypes?.length ? ` (${outcomeTypes.join(", ")})` : ""}`
        : null,
    ]
      .filter(Boolean)
      .map((part) => ` · ${part}`)
      .join("");
    summary = `${plural(total, "task", "tasks")} · ${archivedScope === "included" ? "including" : "excluding"} archived${attention}${restricted ? " · visible to this credential" : ""}`;
    const paged = Boolean(after) || nextCursor !== null;
    if (paged && rows.length > 0) {
      position = pagePosition(paging.pageIndex, PAGE_SIZE, rows.length, total);
    }
  }

  const hasFilters =
    typeFilter.length > 0 || searchMode || blocked || outcome.length > 0;
  const noOutcomeTypes =
    outcome.length > 0 && listQuery.data?.scope?.outcome_types?.length === 0;
  let emptyText: string;
  if (searchMode) {
    emptyText = `No tasks match “${urlQ}”.`;
  } else if (noOutcomeTypes) {
    emptyText = `No task type declares a ${outcome.join(" or ")} outcome, so none can match.`;
  } else if (blocked && typeFilter.length === 0 && outcome.length === 0) {
    emptyText = "No open tasks are waiting on prerequisites.";
  } else if (hasFilters) {
    emptyText = "No tasks match these filters.";
  } else if (catalogTotal === 0 || (catalogTotal === null && includeArchived)) {
    emptyText =
      "No tasks in this project. Tasks appear when agents create or claim work units.";
  } else if (!includeArchived) {
    emptyText = "No tasks match these filters. Archived tasks are excluded.";
  } else {
    emptyText = "No tasks match these filters.";
  }

  const showPending = active.isPending || (invalidCursor && Boolean(after));
  const showError = active.isError && !invalidCursor && !active.data;

  return (
    <div className="space-y-4 p-3 md:p-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="font-logo text-xl tracking-tight text-foreground">
          Tasks
        </h1>
        {summary && (
          <span className="font-mono text-[11px] text-fg-faint">{summary}</span>
        )}
        <LastRefreshed dataUpdatedAt={active.dataUpdatedAt} />
        <NewTaskLink />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Input
          ref={searchRef}
          type="search"
          placeholder="Search tasks..."
          aria-label="Search tasks"
          value={qInput}
          onChange={(e) => setQInput(e.target.value)}
          className="w-64"
        />
        <MultiSelectFilter
          label="Type"
          options={typeOptions}
          groups={typeGroups}
          selected={typeFilter}
          onChange={setTypeFilter}
          optionMeta={typeCount}
        />
        {!searchMode && (
          <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
            <Checkbox
              id={archivedId}
              checked={includeArchived}
              onCheckedChange={(checked) =>
                setIncludeArchived(checked === true)
              }
            />
            <label htmlFor={archivedId} className="cursor-pointer">
              Include archived
            </label>
          </div>
        )}
        {(typeFilter.length > 0 || qInput || blocked || outcome.length > 0) && (
          <Button variant="ghost" size="sm" onClick={resetFilters}>
            Reset
          </Button>
        )}
      </div>

      {catalogQuery.isError && !catalog && (
        <SectionFailure
          kind={classifyApiError(catalogQuery.error)}
          error={catalogQuery.error}
          label="task types"
          forbidden="Task types are not available to this credential."
          onRetry={() => void catalogQuery.refetch()}
        />
      )}
      {catalog?.incomplete?.declared_types && (
        <p className="text-xs text-muted-foreground">
          Schema definitions are unavailable. Types are listed without
          declarations.
        </p>
      )}

      {typeFilter.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {typeFilter.map((t) => (
            <span
              key={t}
              className="inline-flex items-center gap-1 rounded-full bg-tint-blue-08 px-2.5 py-0.5 font-mono text-[11px] text-signal-blue"
            >
              type: {t}
              {missingTypes.includes(t) && (
                <span className="text-muted-foreground">(not available)</span>
              )}
              <button
                type="button"
                onClick={() => setTypeFilter(typeFilter.filter((x) => x !== t))}
                className="flex size-7 cursor-pointer items-center justify-center rounded-sm text-muted-foreground hover:text-foreground"
                aria-label={`Remove type filter: ${t}`}
              >
                <RemoveIcon />
              </button>
            </span>
          ))}
        </div>
      )}

      {!searchMode && (blocked || outcome.length > 0) && (
        <div className="flex flex-wrap items-center gap-1.5">
          {blocked && (
            <span className="inline-flex items-center gap-1 rounded-full bg-tint-blue-08 px-2.5 py-0.5 font-mono text-[11px] text-signal-blue">
              blocked: waiting on prerequisites
              <button
                type="button"
                onClick={() => clearParam("blocked")}
                className="flex size-7 cursor-pointer items-center justify-center rounded-sm text-muted-foreground hover:text-foreground"
                aria-label="Remove blocked filter"
              >
                <RemoveIcon />
              </button>
            </span>
          )}
          {outcome.length > 0 && (
            <span className="inline-flex items-center gap-1 rounded-full bg-tint-blue-08 px-2.5 py-0.5 font-mono text-[11px] text-signal-blue">
              outcome: {outcome.join(", ")}
              <button
                type="button"
                onClick={() => clearParam("outcome")}
                className="flex size-7 cursor-pointer items-center justify-center rounded-sm text-muted-foreground hover:text-foreground"
                aria-label="Remove outcome filter"
              >
                <RemoveIcon />
              </button>
            </span>
          )}
        </div>
      )}

      {shortQuery && (
        <p className="text-xs text-muted-foreground">
          Type at least {TASK_SEARCH_MIN_LENGTH} characters to search.
        </p>
      )}
      {cursorReset && (
        <p className="text-xs text-muted-foreground">{CURSOR_RESET_NOTICE}</p>
      )}

      {showError ? (
        <TableError
          error={active.error}
          onRetry={() => void active.refetch()}
        />
      ) : showPending ? (
        <div className="overflow-hidden rounded-lg border border-border">
          <Table aria-label="Tasks">
            <TableHeader>
              <TableRow>
                <TableHead>ID</TableHead>
                <TableHead>Title</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>State</TableHead>
                <TableHead className="text-right">Updated</TableHead>
                <TableHead>Created By</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableSkeleton rows={5} columns={6} />
            </TableBody>
          </Table>
        </div>
      ) : rows.length === 0 ? (
        <div className="py-12 text-center">
          <p className="text-muted-foreground">{emptyText}</p>
        </div>
      ) : (
        <div
          className="overflow-hidden rounded-lg border border-border focus-visible:outline-none"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: table container needs focus for keyboard row navigation
          // biome-ignore lint/a11y/useSemanticElements: div wraps a table, role="grid" enables keyboard nav
          tabIndex={0}
          role="grid"
          onKeyDown={handleTableKeyDown}
        >
          <Table aria-label="Tasks" aria-rowcount={rows.length}>
            <TableHeader>
              {searchMode ? (
                <TableRow>
                  <TableHead>ID</TableHead>
                  <TableHead>Title</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead title="Results are ranked by relevance">
                    Match · Relevance
                  </TableHead>
                </TableRow>
              ) : (
                <TableRow>
                  <SortableHead
                    sortKey="id"
                    active={sort.key === "id"}
                    dir={sort.key === "id" ? sort.dir : null}
                    onSort={() => toggleSort("id")}
                    title="Unique task identifier"
                  >
                    ID
                  </SortableHead>
                  <TableHead title="Title as the task type presents it">
                    Title
                  </TableHead>
                  <SortableHead
                    sortKey="type"
                    active={sort.key === "type"}
                    dir={sort.key === "type" ? sort.dir : null}
                    onSort={() => toggleSort("type")}
                    title="Task type defined by schema"
                  >
                    Type
                  </SortableHead>
                  <TableHead title="Lifecycle state declared by the task type">
                    State
                  </TableHead>
                  <SortableHead
                    sortKey="updated"
                    active={sort.key === "updated"}
                    dir={sort.key === "updated" ? sort.dir : null}
                    onSort={() => toggleSort("updated")}
                    className="text-right"
                    title="Last modification time"
                  >
                    Updated
                  </SortableHead>
                  <TableHead title="Agent or token that created this task">
                    Created By
                  </TableHead>
                </TableRow>
              )}
            </TableHeader>
            <TableBody>
              {rows.map((row, idx) => {
                const entry = entries.get(row.type);
                const focused = idx === focusIdx;
                const state = searchMode ? null : taskState(row.data, entry);
                return (
                  <TableRow
                    key={row.id}
                    aria-rowindex={idx + 1}
                    className={`group/row ${selectedId === row.id ? "bg-tint-blue-08" : ""} ${focused ? "bg-[var(--color-row-hover)]" : ""}`}
                  >
                    <TableCell>
                      <span className="inline-flex items-center gap-1.5">
                        <Link
                          to={taskLink(row.id)}
                          state={location.state}
                          className={linkClass}
                        >
                          {row.id}
                        </Link>
                        <CopyButton value={row.id} />
                      </span>
                    </TableCell>
                    <TableCell className="max-w-[28ch] truncate font-sans text-foreground">
                      {row.title ?? <Muted>—</Muted>}
                    </TableCell>
                    <TableCell>
                      <TypeCell type={row.type} entry={entry} />
                    </TableCell>
                    {searchMode ? (
                      <TableCell>
                        {row.snippet ? (
                          <span
                            className="text-xs text-foreground [&_mark]:rounded-sm [&_mark]:bg-tint-amber [&_mark]:text-status-amber"
                            // biome-ignore lint/security/noDangerouslySetInnerHtml: FTS5 snippet sanitized to highlight tags only
                            dangerouslySetInnerHTML={{
                              __html: sanitizeSnippet(row.snippet),
                            }}
                          />
                        ) : (
                          <Muted>—</Muted>
                        )}
                      </TableCell>
                    ) : (
                      <>
                        <TableCell>
                          {state ? (
                            <Badge variant={state.variant}>{state.value}</Badge>
                          ) : null}
                        </TableCell>
                        <TableCell className="tila-num text-right text-muted-foreground">
                          {row.updated_at !== undefined
                            ? relativeTime(row.updated_at)
                            : null}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {row.created_by}
                        </TableCell>
                      </>
                    )}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          <p
            className="px-3 py-1.5 text-[10px] text-fg-faint"
            aria-hidden="true"
          >
            <kbd className="font-mono">/</kbd> search{" "}
            <kbd className="font-mono">j</kbd>/
            <kbd className="font-mono">k</kbd> navigate{" "}
            <kbd className="font-mono">Enter</kbd> open{" "}
            <kbd className="font-mono">⌘K</kbd> palette
          </p>
        </div>
      )}

      {!showPending && !showError && (
        <PageNav
          paging={paging}
          nextCursor={nextCursor}
          position={position}
          label="Task pages"
          nextLabel={searchMode ? "More results" : "Next"}
        />
      )}
    </div>
  );
}
