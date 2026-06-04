import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { Input } from "@/components/ui/input";
import { LastRefreshed } from "@/components/ui/last-refreshed";
import { MultiSelectFilter } from "@/components/ui/multi-select-filter";
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
import { useTasks } from "@/hooks/use-api";
import { useAuth } from "@/hooks/use-auth";
import { useDebouncedValue } from "@/hooks/use-debounce";
import { useTableKeyNav } from "@/hooks/use-table-key-nav";
import { useTimeTick } from "@/hooks/use-time-tick";
import { relativeTime } from "@/lib/time";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useMatch, useNavigate, useSearchParams } from "react-router";

type Entity = {
  id: string;
  type: string;
  schema_version: number;
  data: Record<string, unknown> | null;
  archived: number;
  created_at: number;
  updated_at: number;
  created_by: string;
};

function entityStatus(entity: Entity): string | null {
  const s = (entity.data as Record<string, unknown> | null)?.status;
  return typeof s === "string" ? s : null;
}

function statusVariant(
  status: string,
): "green" | "amber" | "red" | "gray" | "default" {
  switch (status) {
    case "done":
    case "complete":
    case "completed":
    case "active":
      return "green";
    case "in-progress":
    case "running":
    case "claimed":
      return "amber";
    case "failed":
    case "error":
    case "blocked":
      return "red";
    default:
      return "gray";
  }
}

function parseSort(
  raw: string | null,
): { key: "updated" | "type" | "id"; dir: "asc" | "desc" } | null {
  if (!raw) return null;
  const [k, d] = raw.split(":");
  if (["updated", "type", "id"].includes(k) && (d === "asc" || d === "desc")) {
    return { key: k as "updated" | "type" | "id", dir: d };
  }
  return null;
}

export function TasksPage() {
  useTimeTick();
  const { projectId } = useAuth();
  const detailMatch = useMatch(`/p/${projectId}/tasks/:id`);
  const selectedId = detailMatch?.params.id;
  const [searchParams, setSearchParams] = useSearchParams();

  const [typeFilter, setTypeFilter] = useState<string[]>(
    () => searchParams.get("type")?.split(",").filter(Boolean) ?? [],
  );
  const [idFilter, setIdFilter] = useState(() => searchParams.get("q") ?? "");
  const [sort, toggleSort] = useSort<"updated" | "type" | "id">(
    parseSort(searchParams.get("sort")) ?? { key: "updated", dir: "desc" },
  );

  useEffect(() => {
    const params = new URLSearchParams();
    if (typeFilter.length > 0) params.set("type", typeFilter.join(","));
    if (idFilter.trim()) params.set("q", idFilter.trim());
    if (sort) params.set("sort", `${sort.key}:${sort.dir}`);
    setSearchParams(params, { replace: true });
  }, [typeFilter, idFilter, sort, setSearchParams]);

  const { data, isLoading, isError, error, refetch, dataUpdatedAt } = useTasks({
    type: typeFilter.length > 0 ? typeFilter : undefined,
  });
  const allEntities = data?.entities ?? [];

  const typeOptions = useMemo(
    () => [...new Set(allEntities.map((e) => e.type))].sort(),
    [allEntities],
  );

  const debouncedIdFilter = useDebouncedValue(idFilter);

  const entities = useMemo(() => {
    let filtered = allEntities;
    if (debouncedIdFilter.trim()) {
      const q = debouncedIdFilter.toLowerCase().trim();
      filtered = allEntities.filter((e) => e.id.toLowerCase().includes(q));
    }
    if (!sort) return filtered;
    const dir = sort.dir === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => {
      switch (sort.key) {
        case "updated":
          return (a.updated_at - b.updated_at) * dir;
        case "type":
          return a.type.localeCompare(b.type) * dir;
        case "id":
          return a.id.localeCompare(b.id) * dir;
        default:
          return 0;
      }
    });
  }, [allEntities, debouncedIdFilter, sort]);

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

  const navigate = useNavigate();
  const tableRef = useRef<HTMLDivElement>(null);
  const { focusIdx, handleKeyDown: handleTableKeyDown } = useTableKeyNav(
    entities.length,
    (idx) => navigate(`/p/${projectId}/tasks/${entities[idx].id}`),
  );

  return (
    <div className="space-y-4 p-3 md:p-6">
      <div className="flex items-center gap-3">
        <h1 className="font-logo text-xl tracking-tight text-foreground">
          Tasks
        </h1>
        {entities.length > 0 && (
          <span className="tila-num rounded-full border border-border bg-card px-[7px] py-px font-mono text-[11px] text-fg-faint">
            {entities.length}
          </span>
        )}
        <LastRefreshed dataUpdatedAt={dataUpdatedAt} />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Input
          ref={searchRef}
          type="text"
          placeholder="Filter by ID..."
          aria-label="Filter tasks by ID"
          value={idFilter}
          onChange={(e) => setIdFilter(e.target.value)}
          className="w-52"
        />
        <MultiSelectFilter
          label="Type"
          options={typeOptions}
          selected={typeFilter}
          onChange={setTypeFilter}
        />
        {(typeFilter.length > 0 || idFilter) && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setTypeFilter([]);
              setIdFilter("");
            }}
          >
            Reset
          </Button>
        )}
      </div>

      {(typeFilter.length > 0 || debouncedIdFilter) && (
        <div className="flex flex-wrap items-center gap-1.5">
          {typeFilter.map((t) => (
            <span
              key={t}
              className="inline-flex items-center gap-1 rounded-full bg-tint-blue-08 px-2.5 py-0.5 font-mono text-[11px] text-signal-blue"
            >
              type: {t}
              <button
                type="button"
                onClick={() =>
                  setTypeFilter((prev) => prev.filter((x) => x !== t))
                }
                className="flex size-7 cursor-pointer items-center justify-center rounded-sm text-muted-foreground hover:text-foreground"
                aria-label={`Remove type filter: ${t}`}
              >
                x
              </button>
            </span>
          ))}
          {debouncedIdFilter && (
            <span className="inline-flex items-center gap-1 rounded-full bg-tint-blue-08 px-2.5 py-0.5 font-mono text-[11px] text-signal-blue">
              id: {debouncedIdFilter}
              <button
                type="button"
                onClick={() => setIdFilter("")}
                className="flex size-7 cursor-pointer items-center justify-center rounded-sm text-muted-foreground hover:text-foreground"
                aria-label="Remove ID filter"
              >
                x
              </button>
            </span>
          )}
          <span className="text-[10px] text-fg-faint">
            {entities.length} of {allEntities.length}
          </span>
        </div>
      )}

      {isError ? (
        <TableError error={error} onRetry={() => refetch()} />
      ) : isLoading ? (
        <div className="overflow-hidden rounded-lg border border-border">
          <Table aria-label="Tasks">
            <TableHeader>
              <TableRow>
                <TableHead>ID</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Updated</TableHead>
                <TableHead>Created By</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableSkeleton rows={5} columns={5} />
            </TableBody>
          </Table>
        </div>
      ) : entities.length === 0 ? (
        <div className="py-12 text-center">
          <p className="text-muted-foreground">
            {allEntities.length === 0
              ? "No tasks in this project. Tasks appear when agents create or claim work units."
              : "No tasks match the current filters."}
          </p>
          {allEntities.length > 0 && (
            <button
              type="button"
              onClick={() => {
                setTypeFilter([]);
                setIdFilter("");
              }}
              className="mt-2 cursor-pointer text-sm text-signal-blue hover:text-signal-blue-hover"
            >
              Clear all filters
            </button>
          )}
        </div>
      ) : (
        <div
          ref={tableRef}
          className="overflow-hidden rounded-lg border border-border focus-visible:outline-none"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: table container needs focus for keyboard row navigation
          // biome-ignore lint/a11y/useSemanticElements: div wraps a table, role="grid" enables keyboard nav
          tabIndex={0}
          role="grid"
          onKeyDown={handleTableKeyDown}
        >
          <Table aria-label="Tasks">
            <TableHeader>
              <TableRow>
                <SortableHead
                  sortKey="id"
                  active={sort?.key === "id"}
                  dir={sort?.key === "id" ? sort.dir : null}
                  onSort={() => toggleSort("id")}
                  title="Unique task identifier"
                >
                  ID
                </SortableHead>
                <SortableHead
                  sortKey="type"
                  active={sort?.key === "type"}
                  dir={sort?.key === "type" ? sort.dir : null}
                  onSort={() => toggleSort("type")}
                  title="Task type defined by schema"
                >
                  Type
                </SortableHead>
                <TableHead title="Current lifecycle status from task data">
                  Status
                </TableHead>
                <SortableHead
                  sortKey="updated"
                  active={sort?.key === "updated"}
                  dir={sort?.key === "updated" ? sort.dir : null}
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
            </TableHeader>
            <TableBody>
              {entities.map((entity, idx) => {
                const status = entityStatus(entity);
                const focused = idx === focusIdx;
                return (
                  <TableRow
                    key={entity.id}
                    className={`group/row ${selectedId === entity.id ? "bg-tint-blue-08" : ""} ${focused ? "bg-[var(--color-row-hover)]" : ""}`}
                  >
                    <TableCell>
                      <span className="inline-flex items-center gap-1.5">
                        <Link
                          to={`/p/${projectId}/tasks/${entity.id}`}
                          className="rounded-sm text-signal-blue underline decoration-signal-blue/40 underline-offset-2 hover:text-signal-blue-hover hover:decoration-signal-blue focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal-blue"
                        >
                          {entity.id}
                        </Link>
                        <CopyButton value={entity.id} />
                      </span>
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary">{entity.type}</Badge>
                    </TableCell>
                    <TableCell>
                      {status ? (
                        <Badge variant={statusVariant(status)}>{status}</Badge>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="tila-num text-right text-muted-foreground">
                      {relativeTime(entity.updated_at)}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {entity.created_by}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          <p
            className="px-3 py-1.5 text-[10px] text-fg-faint"
            aria-hidden="true"
          >
            <kbd className="font-mono">/</kbd> filter{" "}
            <kbd className="font-mono">j</kbd>/
            <kbd className="font-mono">k</kbd> navigate{" "}
            <kbd className="font-mono">Enter</kbd> open{" "}
            <kbd className="font-mono">⌘K</kbd> search
          </p>
        </div>
      )}
    </div>
  );
}
