import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LastRefreshed } from "@/components/ui/last-refreshed";
import { SortableHead, useSort } from "@/components/ui/sortable-head";
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
import { useRecordTypes, useRecords } from "@/hooks/use-api";
import { useAuth } from "@/hooks/use-auth";
import { useDebouncedValue } from "@/hooks/use-debounce";
import { useTableKeyNav } from "@/hooks/use-table-key-nav";
import { useTimeTick } from "@/hooks/use-time-tick";
import { relativeTime } from "@/lib/time";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";

type RecordListItem = {
  type: string;
  key: string;
  revision: number;
  updated_at: number;
  updated_by: string;
  archived: number;
  tags: string[];
};

function parseSort(
  raw: string | null,
): { key: "updated" | "key" | "revision"; dir: "asc" | "desc" } | null {
  if (!raw) return null;
  const [k, d] = raw.split(":");
  if (
    ["updated", "key", "revision"].includes(k) &&
    (d === "asc" || d === "desc")
  ) {
    return { key: k as "updated" | "key" | "revision", dir: d };
  }
  return null;
}

export function RecordsPage() {
  useTimeTick();
  const { projectId } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();

  const [selectedType, setSelectedType] = useState<string | undefined>(
    () => searchParams.get("type") || undefined,
  );
  const [keyFilter, setKeyFilter] = useState(() => searchParams.get("q") ?? "");
  const [includeArchived, setIncludeArchived] = useState(
    () => searchParams.get("archived") === "1",
  );
  const [sort, toggleSort] = useSort<"updated" | "key" | "revision">(
    parseSort(searchParams.get("sort")) ?? { key: "updated", dir: "desc" },
  );

  const {
    data: typesData,
    isLoading: typesLoading,
    isError: typesError,
    refetch: refetchTypes,
  } = useRecordTypes();
  const types = typesData?.types ?? [];

  useEffect(() => {
    if (!selectedType && types.length > 0) {
      setSelectedType(types[0]);
    }
  }, [types, selectedType]);

  useEffect(() => {
    const params = new URLSearchParams();
    if (selectedType) params.set("type", selectedType);
    if (keyFilter.trim()) params.set("q", keyFilter.trim());
    if (includeArchived) params.set("archived", "1");
    if (sort) params.set("sort", `${sort.key}:${sort.dir}`);
    setSearchParams(params);
  }, [selectedType, keyFilter, includeArchived, sort, setSearchParams]);

  const { data, isLoading, isError, error, dataUpdatedAt, refetch } =
    useRecords(selectedType, {
      "include-archived": includeArchived ? "true" : undefined,
    });
  const allRecords: RecordListItem[] = data?.items ?? [];

  const debouncedKeyFilter = useDebouncedValue(keyFilter);

  const records = useMemo(() => {
    let filtered = allRecords;
    if (debouncedKeyFilter.trim()) {
      const q = debouncedKeyFilter.toLowerCase().trim();
      filtered = allRecords.filter((r) => r.key.toLowerCase().includes(q));
    }
    if (!sort) return filtered;
    const dir = sort.dir === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => {
      switch (sort.key) {
        case "updated":
          return (a.updated_at - b.updated_at) * dir;
        case "key":
          return a.key.localeCompare(b.key) * dir;
        case "revision":
          return (a.revision - b.revision) * dir;
        default:
          return 0;
      }
    });
  }, [allRecords, debouncedKeyFilter, sort]);

  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.ctrlKey || e.metaKey) return;
      const tag = document.activeElement?.tagName;
      if (tag === "INPUT") {
        if (e.key === "Escape") {
          e.preventDefault();
          (document.activeElement as HTMLElement)?.blur();
          if (keyFilter) setKeyFilter("");
        }
        return;
      }
      if (tag === "TEXTAREA") return;
      if (e.key === "/") {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (e.key === "a") {
        e.preventDefault();
        setIncludeArchived((v) => !v);
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [keyFilter]);

  const navigate = useNavigate();
  const tableRef = useRef<HTMLDivElement>(null);
  const { focusIdx, handleKeyDown: handleTableKeyDown } = useTableKeyNav(
    records.length,
    (idx) =>
      navigate(
        `/p/${projectId}/records/${records[idx].type}/${records[idx].key}`,
      ),
  );

  return (
    <div className="space-y-4 p-3 md:p-6">
      <div className="flex items-center gap-3">
        <h1 className="font-logo text-xl tracking-tight text-foreground">
          Records
        </h1>
        {types.length > 0 && (
          <span className="tila-num rounded-full border border-border bg-card px-[7px] py-px font-mono text-[11px] text-fg-faint">
            {types.length} {types.length === 1 ? "type" : "types"}
          </span>
        )}
        {!isLoading && !isError && selectedType && (
          <span className="font-mono text-xs text-muted-foreground tabular-nums">
            {allRecords.length} {allRecords.length === 1 ? "record" : "records"}
          </span>
        )}
        <LastRefreshed dataUpdatedAt={dataUpdatedAt} />
      </div>

      {typesLoading && (
        <p className="text-sm text-muted-foreground">Loading types...</p>
      )}

      {typesError && (
        <TableError
          error="Failed to load record types"
          onRetry={() => refetchTypes()}
        />
      )}

      {!typesLoading && !typesError && types.length === 0 && (
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

      {types.length > 0 && (
        <>
          <div
            className="flex flex-wrap items-center gap-1.5"
            role="tablist"
            aria-label="Record types"
            onKeyDown={(e) => {
              if (!selectedType) return;
              const idx = types.indexOf(selectedType);
              if (e.key === "ArrowRight" && idx < types.length - 1) {
                e.preventDefault();
                setSelectedType(types[idx + 1]);
              } else if (e.key === "ArrowLeft" && idx > 0) {
                e.preventDefault();
                setSelectedType(types[idx - 1]);
              }
            }}
          >
            {types.map((t) => (
              <button
                key={t}
                type="button"
                role="tab"
                id={`tab-${t}`}
                aria-selected={selectedType === t}
                aria-controls="tabpanel-records"
                tabIndex={selectedType === t ? 0 : -1}
                onClick={() => setSelectedType(t)}
                className={`rounded-sm px-2.5 py-1 text-[13px] transition-[background-color,color] duration-150 cursor-pointer ${
                  selectedType === t
                    ? "text-signal-blue bg-tint-blue-15"
                    : "text-muted-foreground hover:text-foreground hover:bg-[var(--color-row-hover-2)]"
                }`}
              >
                {t}
              </button>
            ))}
          </div>

          {selectedType && (
            <div
              role="tabpanel"
              id="tabpanel-records"
              aria-labelledby={`tab-${selectedType}`}
              className="space-y-3"
            >
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  ref={searchRef}
                  id="record-key-filter"
                  name="q"
                  value={keyFilter}
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
                      setKeyFilter("");
                      setIncludeArchived(false);
                    }}
                  >
                    Reset
                  </Button>
                )}
              </div>

              {debouncedKeyFilter && !isLoading && !isError && (
                <div className="flex items-center gap-1.5">
                  <span className="inline-flex items-center gap-1 rounded-full bg-tint-blue-08 px-2.5 py-0.5 font-mono text-[11px] text-signal-blue">
                    key: {debouncedKeyFilter}
                  </span>
                  <span className="text-[10px] text-fg-faint">
                    {records.length} of {allRecords.length}
                  </span>
                </div>
              )}

              {isLoading && (
                <div className="overflow-hidden rounded-lg border border-border">
                  <Table aria-label="Records">
                    <TableHeader>
                      <TableRow>
                        <TableHead>Key</TableHead>
                        <TableHead>Revision</TableHead>
                        <TableHead>Updated</TableHead>
                        <TableHead>Updated By</TableHead>
                        <TableHead>Tags</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      <TableSkeleton columns={5} rows={5} />
                    </TableBody>
                  </Table>
                </div>
              )}

              {isError && (
                <TableError error={error} onRetry={() => refetch()} />
              )}

              {!isLoading && !isError && records.length === 0 && (
                <div className="py-8 text-center">
                  <p className="text-sm text-muted-foreground">
                    {debouncedKeyFilter
                      ? `No ${selectedType} records match "${debouncedKeyFilter}".`
                      : `No ${selectedType} records yet.`}
                  </p>
                  <p className="mt-1 text-xs text-fg-faint">
                    {debouncedKeyFilter
                      ? "Try a broader filter or clear it with Reset."
                      : `Create records with tila record set ${selectedType} <key>`}
                  </p>
                  {!includeArchived && !debouncedKeyFilter && (
                    <button
                      type="button"
                      onClick={() => setIncludeArchived(true)}
                      className="mt-2 cursor-pointer text-xs text-signal-blue hover:text-signal-blue-hover"
                    >
                      Check archived records
                    </button>
                  )}
                  {!includeArchived && debouncedKeyFilter && (
                    <button
                      type="button"
                      onClick={() => setIncludeArchived(true)}
                      className="mt-2 cursor-pointer text-xs text-signal-blue hover:text-signal-blue-hover"
                    >
                      Search archived records too
                    </button>
                  )}
                </div>
              )}

              {!isLoading && !isError && records.length > 0 && (
                <>
                  <div
                    ref={tableRef}
                    onKeyDown={handleTableKeyDown}
                    className="overflow-hidden rounded-lg border border-border focus-visible:outline-none"
                    // biome-ignore lint/a11y/noNoninteractiveTabindex: table container needs focus for keyboard row navigation
                    // biome-ignore lint/a11y/useSemanticElements: div wraps a table, role="grid" enables keyboard nav
                    tabIndex={0}
                    role="grid"
                  >
                    <Table aria-label="Records">
                      <TableHeader>
                        <TableRow>
                          <SortableHead
                            sortKey="key"
                            active={sort?.key === "key"}
                            dir={sort?.key === "key" ? sort.dir : null}
                            onSort={() => toggleSort("key")}
                            title="Record key (unique within type)"
                          >
                            Key
                          </SortableHead>
                          <SortableHead
                            sortKey="revision"
                            active={sort?.key === "revision"}
                            dir={sort?.key === "revision" ? sort.dir : null}
                            onSort={() => toggleSort("revision")}
                            title="Revision number"
                          >
                            Revision
                          </SortableHead>
                          <SortableHead
                            sortKey="updated"
                            active={sort?.key === "updated"}
                            dir={sort?.key === "updated" ? sort.dir : null}
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
                            className={`cursor-pointer ${focusIdx === idx ? "bg-[var(--color-row-hover)]" : ""}`}
                          >
                            <TableCell>
                              <span className="inline-flex items-center gap-1.5">
                                <Link
                                  to={`/p/${projectId}/records/${r.type}/${r.key}`}
                                  className="font-mono text-signal-blue underline decoration-signal-blue/40 underline-offset-2 hover:text-signal-blue-hover"
                                >
                                  {r.key}
                                </Link>
                                {r.archived === 1 && (
                                  <Badge variant="red">archived</Badge>
                                )}
                              </span>
                            </TableCell>
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
            </div>
          )}
        </>
      )}
    </div>
  );
}
