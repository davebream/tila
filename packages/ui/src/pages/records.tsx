import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LastRefreshed } from "@/components/ui/last-refreshed";
import { PageNav } from "@/components/ui/page-nav";
import {
  SectionFailure,
  SectionNotice,
  StaleNotice,
} from "@/components/ui/query-section";
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
import { NewRecordLink } from "@/components/work/create-links";
import { useRecordPage, useRecordTypes } from "@/hooks/use-api";
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
import { deriveSectionState } from "@/lib/query-state";
import {
  DEFAULT_RECORD_SORT,
  RECORD_PAGE_SIZE,
  type RecordSort,
  type RecordSortKey,
  parseRecordSort,
  recordPageParams,
} from "@/lib/record-list";
import { relativeTime } from "@/lib/time";
import type {
  RecordCatalogEntry,
  RecordTypesResponse,
  TypeDeclaration,
} from "@tila/schemas";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router";

/** A record type tab: a catalog entry, or a bare name from an older server. */
type TypeTab = {
  type: string;
  declaration: TypeDeclaration;
  entry?: RecordCatalogEntry;
};

const DECLARATION_ORDER: TypeDeclaration[] = [
  "declared",
  "undeclared",
  "unknown",
];

/**
 * Declared types first (including empty ones), then types the schema does not
 * declare, then types whose definitions could not be read.
 */
function typeTabs(data: RecordTypesResponse | undefined): TypeTab[] {
  if (!data) return [];
  const tabs: TypeTab[] = data.entries
    ? data.entries.map((entry) => ({
        type: entry.type,
        declaration: entry.declaration,
        entry,
      }))
    : data.types.map((type) => ({
        type,
        declaration: !data.declared_types
          ? "unknown"
          : data.declared_types.includes(type)
            ? "declared"
            : "undeclared",
      }));
  return DECLARATION_ORDER.flatMap((d) =>
    tabs.filter((t) => t.declaration === d),
  );
}

const KIND_LABELS = { configuration: "Configuration", content: "Content" };

/** Classification only when the definition declares it; never from the name. */
export function ClassificationBadge({
  entry,
}: {
  entry: RecordCatalogEntry | undefined;
}) {
  const kind = entry?.definition?.presentation?.kind;
  if (!kind) return null;
  return <Badge variant="gray">{KIND_LABELS[kind]}</Badge>;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function RecordsPage() {
  useTimeTick();
  const { projectId } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const urlType = searchParams.get("type") || undefined;
  const urlQ = (searchParams.get("q") ?? "").trim();
  const sort = parseRecordSort(searchParams.get("sort"));
  const includeArchived = searchParams.get("archived") === "1";
  const paging = useCursorPaging();

  // Type, filter, sort and archived changes start again from page one.
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

  // The key filter is local while typing; the URL follows after a debounce.
  const [keyFilter, setKeyFilter] = useState(urlQ);
  const debouncedKey = useDebouncedValue(keyFilter);
  const syncedQ = useRef(urlQ);
  useEffect(() => {
    if (urlQ !== syncedQ.current) {
      syncedQ.current = urlQ;
      setKeyFilter(urlQ);
    }
  }, [urlQ]);
  useEffect(() => {
    const trimmed = debouncedKey.trim();
    if (trimmed === syncedQ.current) return;
    syncedQ.current = trimmed;
    updateParamsRef.current((p) => {
      if (trimmed) p.set("q", trimmed);
      else p.delete("q");
    });
  }, [debouncedKey]);

  function clearKeyFilter() {
    syncedQ.current = "";
    setKeyFilter("");
    updateParams((p) => p.delete("q"));
  }

  function selectType(type: string) {
    updateParams((p) => p.set("type", type));
  }

  function setIncludeArchived(include: boolean) {
    updateParams((p) => {
      if (include) p.set("archived", "1");
      else p.delete("archived");
    });
  }

  function toggleSort(key: RecordSortKey) {
    const next: RecordSort =
      sort.key === key
        ? { key, dir: sort.dir === "desc" ? "asc" : "desc" }
        : { key, dir: key === "key" ? "asc" : "desc" };
    updateParams((p) => {
      if (
        next.key === DEFAULT_RECORD_SORT.key &&
        next.dir === DEFAULT_RECORD_SORT.dir
      ) {
        p.delete("sort");
      } else {
        p.set("sort", `${next.key}:${next.dir}`);
      }
    });
  }

  // --- Types ---

  const typesQuery = useRecordTypes();
  const typesState = deriveSectionState(typesQuery);
  // After a 403/404 refresh the query still holds the old list; only a
  // currently readable listing is used.
  const typesData = typesState.phase === "ready" ? typesState.data : undefined;
  const tabs = useMemo(() => typeTabs(typesData), [typesData]);
  const typesIncomplete = typesData?.incomplete;
  const incompleteReasons = [
    typesIncomplete?.declared_types === "unavailable"
      ? "the schema could not be read"
      : typesIncomplete?.declared_types === "invalid"
        ? "the schema is invalid"
        : null,
    typesIncomplete?.in_use_types === "unavailable"
      ? "types in use could not be listed"
      : null,
  ].filter((reason): reason is string => reason !== null);
  // "Invalid" will not fix itself on retry; "unavailable" might.
  const incompleteRetryable =
    typesIncomplete?.declared_types === "unavailable" ||
    typesIncomplete?.in_use_types === "unavailable";

  // With no type in the URL, open the first tab. A type in the URL is never
  // replaced, even when the catalog does not list it.
  const firstType = tabs[0]?.type;
  useEffect(() => {
    if (!urlType && firstType) {
      updateParamsRef.current((p) => p.set("type", firstType));
    }
  }, [urlType, firstType]);

  const selectedTab = tabs.find((t) => t.type === urlType);
  const selectedEntry = selectedTab?.entry;
  const typeNotAvailable =
    Boolean(urlType) && typesData !== undefined && !selectedTab;
  // The list waits for the catalog so an unknown type is never requested. An
  // incomplete or failed catalog may omit a type that still has records.
  const listType =
    urlType &&
    (typesState.phase === "failed" ||
      (typesData !== undefined && (selectedTab || typesIncomplete)))
      ? urlType
      : undefined;

  // --- Rows ---

  const listQuery = useRecordPage(listType, recordPageParams(searchParams));
  const invalidCursor = useDropInvalidCursor(listQuery.error, paging);
  const records = listQuery.data?.items ?? [];
  const meta = listQuery.data?.meta;
  const nextCursor = meta?.next_cursor ?? null;
  const showTitle =
    Boolean(selectedEntry?.definition?.presentation?.title) ||
    records.some((r) => "title" in r);

  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.ctrlKey || e.metaKey) return;
      const tag = document.activeElement?.tagName;
      if (tag === "INPUT") {
        if (e.key === "Escape") {
          e.preventDefault();
          (document.activeElement as HTMLElement)?.blur();
          if (keyFilter) clearKeyFilter();
        }
        return;
      }
      if (tag === "TEXTAREA") return;
      if (e.key === "/") {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (e.key === "a") {
        e.preventDefault();
        setIncludeArchived(!includeArchived);
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  });

  // The drawer opens over the same list page: keep the query string and the
  // page trail so closing it returns to exactly this page.
  const recordLink = (type: string, key: string) => ({
    pathname: `/p/${projectId}/records/${type}/${key}`,
    search: location.search,
  });
  const { focusIdx, handleKeyDown: handleTableKeyDown } = useTableKeyNav(
    records.length,
    (idx) =>
      navigate(recordLink(records[idx].type, records[idx].key), {
        state: location.state,
      }),
  );

  let summary: string | null = null;
  let position: string | null = null;
  if (meta) {
    const archivedScope =
      meta.scope?.archived ?? (includeArchived ? "included" : "excluded");
    summary = `${plural(meta.total, "record", "records")} · ${archivedScope === "included" ? "including" : "excluding"} archived${meta.scope?.restricted ? " · visible to this credential" : ""}`;
    if ((paging.after || nextCursor) && records.length > 0) {
      position = pagePosition(
        paging.pageIndex,
        RECORD_PAGE_SIZE,
        records.length,
        meta.total,
      );
    }
  }

  const showPending = listQuery.isPending || invalidCursor;
  const showError = listQuery.isError && !invalidCursor && !listQuery.data;
  const columns = showTitle ? 6 : 5;

  return (
    <div className="space-y-4 p-3 md:p-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="font-logo text-xl tracking-tight text-foreground">
          Records
        </h1>
        {tabs.length > 0 && (
          <span className="tila-num rounded-full border border-border bg-card px-[7px] py-px font-mono text-[11px] text-fg-faint">
            {plural(tabs.length, "type", "types")}
          </span>
        )}
        {summary && listType && (
          <span className="font-mono text-[11px] text-fg-faint">{summary}</span>
        )}
        <LastRefreshed dataUpdatedAt={listQuery.dataUpdatedAt} />
        <NewRecordLink
          type={urlType}
          declared={selectedEntry?.declaration === "declared"}
        />
      </div>

      {typesState.phase === "pending" && (
        <output className="block text-sm text-muted-foreground">
          Loading types…
        </output>
      )}

      {typesState.phase === "failed" && (
        <SectionFailure
          kind={typesState.kind}
          error={typesState.error}
          label="record types"
          onRetry={() => void typesQuery.refetch()}
        />
      )}

      {typesState.phase === "ready" && typesState.stale && (
        <StaleNotice
          label="record types"
          updatedAt={typesState.updatedAt}
          stale={typesState.stale}
          onRetry={() => void typesQuery.refetch()}
        />
      )}

      {incompleteReasons.length > 0 && (
        <SectionNotice
          onRetry={
            incompleteRetryable ? () => void typesQuery.refetch() : undefined
          }
        >
          Some record types may be missing: {incompleteReasons.join("; ")}.
        </SectionNotice>
      )}

      {typesState.phase === "ready" &&
        !typesState.stale &&
        incompleteReasons.length === 0 &&
        tabs.length === 0 && (
          <div className="py-12 text-center">
            <p className="text-sm text-muted-foreground">
              No record types defined.
            </p>
            <p className="mt-1 text-xs text-fg-faint">
              Add a{" "}
              <code className="rounded bg-card px-1 py-0.5 font-mono text-[11px]">
                [records.&lt;type&gt;]
              </code>{" "}
              section to tila.schema.toml, then run{" "}
              <code className="rounded bg-card px-1 py-0.5 font-mono text-[11px]">
                tila schema apply
              </code>
            </p>
          </div>
        )}

      {tabs.length > 0 && (
        <div
          className="flex flex-wrap items-center gap-1.5"
          role="tablist"
          aria-label="Record types"
          onKeyDown={(e) => {
            const idx = tabs.findIndex((t) => t.type === urlType);
            if (idx === -1) return;
            if (e.key === "ArrowRight" && idx < tabs.length - 1) {
              e.preventDefault();
              selectType(tabs[idx + 1].type);
            } else if (e.key === "ArrowLeft" && idx > 0) {
              e.preventDefault();
              selectType(tabs[idx - 1].type);
            }
          }}
        >
          {tabs.map((tab) => {
            const selected = urlType === tab.type;
            const count = tab.entry
              ? tab.entry.count +
                (includeArchived ? tab.entry.archived_count : 0)
              : null;
            return (
              <button
                key={tab.type}
                type="button"
                role="tab"
                id={`tab-${tab.type}`}
                aria-selected={selected}
                aria-controls="tabpanel-records"
                tabIndex={selected ? 0 : -1}
                onClick={() => selectType(tab.type)}
                className={`inline-flex cursor-pointer items-center gap-1.5 rounded-sm px-2.5 py-1 text-[13px] transition-[background-color,color] duration-150 ${
                  selected
                    ? "bg-tint-blue-15 text-signal-blue"
                    : "text-muted-foreground hover:bg-[var(--color-row-hover-2)] hover:text-foreground"
                }`}
              >
                <span>{tab.type}</span>
                {count !== null && (
                  <span className="tila-num font-mono text-[11px] text-fg-faint">
                    {count}
                  </span>
                )}
                {tab.declaration === "undeclared" && (
                  <Badge variant="amber">Not in schema</Badge>
                )}
                {tab.declaration === "unknown" && (
                  <Badge variant="gray">Definitions unavailable</Badge>
                )}
                <ClassificationBadge entry={tab.entry} />
              </button>
            );
          })}
        </div>
      )}

      {typeNotAvailable && urlType && (
        <SectionNotice>
          <code className="font-mono">{urlType}</code> is not an available
          record type.
        </SectionNotice>
      )}

      {listType && (
        <div
          role="tabpanel"
          id="tabpanel-records"
          aria-labelledby={selectedTab ? `tab-${listType}` : undefined}
          aria-label={selectedTab ? undefined : listType}
          className="space-y-3"
        >
          <div className="flex flex-wrap items-center gap-2">
            <Input
              ref={searchRef}
              id="record-key-filter"
              name="q"
              value={keyFilter}
              maxLength={200}
              onChange={(e) => setKeyFilter(e.target.value)}
              placeholder="Filter by key… ( / )"
              aria-label="Filter records by key"
              className="w-56"
            />
            <label
              className="flex cursor-pointer items-center gap-1.5 text-[13px] text-muted-foreground select-none"
              title="Toggle archived records (A)"
            >
              <input
                type="checkbox"
                checked={includeArchived}
                onChange={() => setIncludeArchived(!includeArchived)}
                className="size-3.5 cursor-pointer rounded-[3px] border border-border bg-card accent-signal-blue"
              />
              Include archived
            </label>
            {(keyFilter || includeArchived) && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  syncedQ.current = "";
                  setKeyFilter("");
                  updateParams((p) => {
                    p.delete("q");
                    p.delete("archived");
                  });
                }}
              >
                Reset
              </Button>
            )}
          </div>

          {paging.cursorReset && (
            <p className="text-xs text-muted-foreground">
              {CURSOR_RESET_NOTICE}
            </p>
          )}

          {showError ? (
            <TableError
              error={listQuery.error}
              onRetry={() => void listQuery.refetch()}
            />
          ) : showPending ? (
            <div className="overflow-hidden rounded-lg border border-border">
              <Table aria-label="Records">
                <TableHeader>
                  <TableRow>
                    <TableHead>Key</TableHead>
                    {showTitle && <TableHead>Title</TableHead>}
                    <TableHead>Revision</TableHead>
                    <TableHead>Updated</TableHead>
                    <TableHead>Updated By</TableHead>
                    <TableHead>Tags</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <TableSkeleton columns={columns} rows={5} />
                </TableBody>
              </Table>
            </div>
          ) : records.length === 0 ? (
            <div className="py-8 text-center">
              <p className="text-sm text-muted-foreground">
                {urlQ ? (
                  `No ${listType} records match “${urlQ}”.`
                ) : (
                  <>
                    No <code className="font-mono">{listType}</code> records.
                  </>
                )}
              </p>
              {!includeArchived && (selectedEntry?.archived_count ?? 0) > 0 && (
                <p className="mt-1 text-xs text-fg-faint">
                  Archived records are excluded.
                </p>
              )}
            </div>
          ) : (
            <>
              <div
                onKeyDown={handleTableKeyDown}
                className="overflow-hidden rounded-lg border border-border focus-visible:outline-none"
                // biome-ignore lint/a11y/noNoninteractiveTabindex: table container needs focus for keyboard row navigation
                // biome-ignore lint/a11y/useSemanticElements: div wraps a table, role="grid" enables keyboard nav
                tabIndex={0}
                role="grid"
              >
                <Table aria-label="Records" aria-rowcount={records.length}>
                  <TableHeader>
                    <TableRow>
                      <SortableHead
                        sortKey="key"
                        active={sort.key === "key"}
                        dir={sort.key === "key" ? sort.dir : null}
                        onSort={() => toggleSort("key")}
                        title="Record key (unique within type)"
                      >
                        Key
                      </SortableHead>
                      {showTitle && (
                        <TableHead title="Title as the record type presents it">
                          Title
                        </TableHead>
                      )}
                      <SortableHead
                        sortKey="revision"
                        active={sort.key === "revision"}
                        dir={sort.key === "revision" ? sort.dir : null}
                        onSort={() => toggleSort("revision")}
                        title="Revision number"
                      >
                        Revision
                      </SortableHead>
                      <SortableHead
                        sortKey="updated"
                        active={sort.key === "updated"}
                        dir={sort.key === "updated" ? sort.dir : null}
                        onSort={() => toggleSort("updated")}
                        title="Last modification time"
                      >
                        Updated
                      </SortableHead>
                      <TableHead title="Token or agent that last modified">
                        Updated By
                      </TableHead>
                      <TableHead title="Record tags">Tags</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {records.map((r, idx) => (
                      <TableRow
                        key={`${r.type}/${r.key}`}
                        aria-rowindex={idx + 1}
                        className={`cursor-pointer ${focusIdx === idx ? "bg-[var(--color-row-hover)]" : ""}`}
                      >
                        <TableCell>
                          <span className="inline-flex items-center gap-1.5">
                            <Link
                              to={recordLink(r.type, r.key)}
                              state={location.state}
                              className="font-mono text-signal-blue underline decoration-signal-blue/40 underline-offset-2 hover:text-signal-blue-hover"
                            >
                              {r.key}
                            </Link>
                            {r.archived === 1 && (
                              <Badge variant="red">archived</Badge>
                            )}
                          </span>
                        </TableCell>
                        {showTitle && (
                          <TableCell className="max-w-[28ch] truncate font-sans text-foreground">
                            {r.title ?? (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </TableCell>
                        )}
                        <TableCell className="font-mono text-xs tabular-nums">
                          {r.revision}
                        </TableCell>
                        <TableCell className="font-mono text-muted-foreground">
                          {relativeTime(r.updated_at)}
                        </TableCell>
                        <TableCell
                          className="max-w-[140px] truncate font-mono text-xs text-muted-foreground"
                          title={r.updated_by}
                        >
                          {r.updated_by}
                        </TableCell>
                        <TableCell>
                          {r.tags.length > 0 ? (
                            <div className="flex flex-wrap gap-1">
                              {r.tags.map((tag) => (
                                <Badge key={tag} variant="gray">
                                  {tag}
                                </Badge>
                              ))}
                            </div>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <div className="flex items-center gap-4 pt-1.5 text-[11px] text-fg-faint">
                <span>
                  <kbd className="font-mono">/</kbd> filter
                </span>
                <span>
                  <kbd className="font-mono">a</kbd> archived
                </span>
                <span>
                  <kbd className="font-mono">↑↓</kbd> navigate
                </span>
                <span>
                  <kbd className="font-mono">↵</kbd> open
                </span>
                <span>
                  <kbd className="font-mono">esc</kbd> clear
                </span>
              </div>
            </>
          )}

          {!showPending && !showError && (
            <PageNav
              paging={paging}
              nextCursor={nextCursor}
              position={position}
              label="Record pages"
            />
          )}
        </div>
      )}
    </div>
  );
}
