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
import { useArtifactSearch, useArtifacts } from "@/hooks/use-api";
import { useAuth } from "@/hooks/use-auth";
import { useDebouncedValue } from "@/hooks/use-debounce";
import { useTableKeyNav } from "@/hooks/use-table-key-nav";
import { useTimeTick } from "@/hooks/use-time-tick";
import { relativeTime } from "@/lib/time";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";

function parseArtifactKey(key: string): { entity: string; hash: string } {
  const parts = key.split("/");
  if (parts.length >= 3) {
    return { entity: parts[1], hash: parts.slice(2).join("/") };
  }
  return { entity: "", hash: key };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

import DOMPurify from "dompurify";

function sanitizeSnippet(snippet: string): string {
  return DOMPurify.sanitize(snippet, {
    ALLOWED_TAGS: ["b", "strong"],
  });
}

export function ArtifactsPage() {
  useTimeTick();
  const { projectId } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();

  const [searchInput, setSearchInput] = useState(
    () => searchParams.get("q") ?? "",
  );
  const [kindFilter, setKindFilter] = useState<string[]>(
    () => searchParams.get("kind")?.split(",").filter(Boolean) ?? [],
  );
  const searchRef = useRef<HTMLInputElement>(null);
  const debouncedQuery = useDebouncedValue(searchInput, 300);
  const isSearchMode = debouncedQuery.length > 0;

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

  function parseArtifactSort(
    raw: string | null,
  ): { key: "produced" | "size" | "kind"; dir: "asc" | "desc" } | null {
    if (!raw) return null;
    const [k, d] = raw.split(":");
    if (
      ["produced", "size", "kind"].includes(k) &&
      (d === "asc" || d === "desc")
    ) {
      return { key: k as "produced" | "size" | "kind", dir: d };
    }
    return null;
  }

  const [listSort, toggleListSort] = useSort<"produced" | "size" | "kind">(
    parseArtifactSort(searchParams.get("sort")) ?? {
      key: "produced",
      dir: "desc",
    },
  );

  useEffect(() => {
    const params = new URLSearchParams();
    if (debouncedQuery) params.set("q", debouncedQuery);
    if (kindFilter.length > 0) params.set("kind", kindFilter.join(","));
    if (listSort) params.set("sort", `${listSort.key}:${listSort.dir}`);
    setSearchParams(params, { replace: true });
  }, [debouncedQuery, kindFilter, listSort, setSearchParams]);

  const {
    data: listData,
    isLoading,
    isError,
    error,
    refetch,
    dataUpdatedAt,
  } = useArtifacts();
  const { data: searchData } = useArtifactSearch({
    q: debouncedQuery,
    kind: kindFilter.length > 0 ? kindFilter : undefined,
  });

  const liveArtifacts = useMemo(
    () => (listData?.artifacts ?? []).filter((a) => !a.tombstoned),
    [listData],
  );

  const kindOptions = useMemo(
    () => [...new Set((listData?.artifacts ?? []).map((a) => a.kind))].sort(),
    [listData],
  );

  function clearFilters() {
    setSearchInput("");
    setKindFilter([]);
  }

  return (
    <div className="space-y-4 p-3 md:p-6">
      <div className="flex items-center gap-3">
        <h1 className="font-logo text-xl tracking-tight text-foreground">
          Artifacts
        </h1>
        {!isSearchMode && liveArtifacts.length > 0 && (
          <span className="tila-num rounded-full border border-border bg-card px-[7px] py-px font-mono text-[11px] text-fg-faint">
            {liveArtifacts.length}
          </span>
        )}
        <LastRefreshed dataUpdatedAt={dataUpdatedAt} />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Input
          ref={searchRef}
          type="text"
          placeholder="Search artifacts..."
          aria-label="Search artifacts"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          className="w-52"
        />
        <MultiSelectFilter
          label="Kind"
          options={kindOptions}
          selected={kindFilter}
          onChange={setKindFilter}
        />
        {(searchInput || kindFilter.length > 0) && (
          <Button variant="ghost" size="sm" onClick={clearFilters}>
            Reset
          </Button>
        )}
      </div>

      {(debouncedQuery || kindFilter.length > 0) && (
        <div className="flex flex-wrap items-center gap-1.5">
          {debouncedQuery && (
            <span className="inline-flex items-center gap-1 rounded-full bg-tint-blue-08 px-2.5 py-0.5 font-mono text-[11px] text-signal-blue">
              search: {debouncedQuery}
              <button
                type="button"
                onClick={() => setSearchInput("")}
                className="flex size-7 cursor-pointer items-center justify-center rounded-sm text-muted-foreground hover:text-foreground"
                aria-label="Remove search filter"
              >
                x
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
                x
              </button>
            </span>
          ))}
        </div>
      )}

      {isSearchMode ? (
        <SearchResults
          data={searchData}
          query={debouncedQuery}
          projectId={projectId}
        />
      ) : isError ? (
        <TableError error={error} onRetry={() => refetch()} />
      ) : isLoading ? (
        <div className="overflow-hidden rounded-lg border border-border">
          <Table aria-label="Artifacts">
            <TableHeader>
              <TableRow>
                <TableHead>Key</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead>MIME</TableHead>
                <TableHead>Size</TableHead>
                <TableHead>Resource</TableHead>
                <TableHead>Produced</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableSkeleton rows={4} columns={6} />
            </TableBody>
          </Table>
        </div>
      ) : (
        <ArtifactList
          artifacts={liveArtifacts}
          projectId={projectId}
          sort={listSort}
          toggleSort={toggleListSort}
        />
      )}
    </div>
  );
}

function ArtifactList({
  artifacts,
  projectId,
  sort,
  toggleSort,
}: {
  projectId: string | null;
  artifacts: Array<{
    r2_key: string;
    resource: string | null;
    kind: string;
    mime_type: string;
    bytes: number;
    produced_at: number;
    produced_by: string;
  }>;
  sort: import("@/components/ui/sortable-head").SortState<
    "produced" | "size" | "kind"
  >;
  toggleSort: (key: "produced" | "size" | "kind") => void;
}) {
  const sorted = useMemo(() => {
    if (!sort) return artifacts;
    const dir = sort.dir === "asc" ? 1 : -1;
    return [...artifacts].sort((a, b) => {
      switch (sort.key) {
        case "produced":
          return (a.produced_at - b.produced_at) * dir;
        case "size":
          return (a.bytes - b.bytes) * dir;
        case "kind":
          return a.kind.localeCompare(b.kind) * dir;
        default:
          return 0;
      }
    });
  }, [artifacts, sort]);

  const navigate = useNavigate();
  const { focusIdx, handleKeyDown } = useTableKeyNav(sorted.length, (idx) =>
    navigate(`/p/${projectId}/artifacts/${sorted[idx].r2_key}`),
  );

  if (artifacts.length === 0) {
    return (
      <p className="py-12 text-center text-muted-foreground">
        No artifacts in this project. Artifacts are created when agents produce
        content-addressed blobs.
      </p>
    );
  }

  return (
    <div
      className="overflow-hidden rounded-lg border border-border focus-visible:outline-none"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard row navigation
      // biome-ignore lint/a11y/useSemanticElements: div wraps table for keyboard nav
      tabIndex={0}
      role="grid"
      onKeyDown={handleKeyDown}
    >
      <Table aria-label="Artifacts">
        <TableHeader>
          <TableRow>
            <TableHead title="Content-addressed R2 storage key">Key</TableHead>
            <SortableHead
              sortKey="kind"
              active={sort?.key === "kind"}
              dir={sort?.key === "kind" ? sort.dir : null}
              onSort={() => toggleSort("kind")}
              title="Artifact category (e.g. source, document, migration)"
            >
              Kind
            </SortableHead>
            <TableHead title="Content type of the stored blob">MIME</TableHead>
            <SortableHead
              sortKey="size"
              active={sort?.key === "size"}
              dir={sort?.key === "size" ? sort.dir : null}
              onSort={() => toggleSort("size")}
              title="Blob size in bytes"
            >
              Size
            </SortableHead>
            <TableHead title="Task or agent that produced this artifact">
              Resource
            </TableHead>
            <SortableHead
              sortKey="produced"
              active={sort?.key === "produced"}
              dir={sort?.key === "produced" ? sort.dir : null}
              onSort={() => toggleSort("produced")}
              title="When this artifact was stored"
            >
              Produced
            </SortableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sorted.map((a, idx) => {
            const keyParts = parseArtifactKey(a.r2_key);
            return (
              <TableRow
                key={a.r2_key}
                className={`group/row ${idx === focusIdx ? "bg-[var(--color-row-hover)]" : ""}`}
              >
                <TableCell>
                  <span className="inline-flex items-center gap-1.5">
                    <Link
                      to={`/p/${projectId}/artifacts/${a.r2_key}`}
                      className="rounded-sm text-signal-blue underline decoration-signal-blue/40 underline-offset-2 hover:text-signal-blue-hover hover:decoration-signal-blue focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal-blue"
                      title={a.r2_key}
                    >
                      {keyParts.entity || a.r2_key}
                    </Link>
                    <CopyButton value={a.r2_key} />
                  </span>
                </TableCell>
                <TableCell>
                  <Badge variant="secondary">{a.kind}</Badge>
                </TableCell>
                <TableCell className="text-foreground">{a.mime_type}</TableCell>
                <TableCell className="tila-num text-foreground">
                  {formatBytes(a.bytes)}
                </TableCell>
                <TableCell className="text-foreground">
                  {a.resource ?? a.produced_by}
                </TableCell>
                <TableCell className="tila-num text-muted-foreground">
                  {relativeTime(a.produced_at)}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      <p className="px-3 py-1.5 text-[10px] text-fg-faint" aria-hidden="true">
        <kbd className="font-mono">/</kbd> filter{" "}
        <kbd className="font-mono">j</kbd>/<kbd className="font-mono">k</kbd>{" "}
        navigate <kbd className="font-mono">Enter</kbd> open{" "}
        <kbd className="font-mono">⌘K</kbd> search
      </p>
    </div>
  );
}

function SearchResults({
  data,
  query,
  projectId,
}: {
  projectId: string | null;
  data:
    | {
        results: Array<{
          r2_key: string;
          kind: string;
          resource: string | null;
          produced_at: number;
          snippet: string | null;
        }>;
      }
    | undefined;
  query: string;
}) {
  if (!data) {
    return <p className="text-muted-foreground">Searching...</p>;
  }

  if (data.results.length === 0) {
    return (
      <div className="py-12 text-center">
        <p className="text-muted-foreground">
          No results for &apos;{query}&apos;. Search uses full-text matching on
          artifact content.
        </p>
        <p className="mt-1 text-xs text-fg-faint">
          Try shorter terms or check spelling.
        </p>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5">
        <span className="text-[11px] text-muted-foreground">
          {data.results.length} result{data.results.length !== 1 ? "s" : ""}{" "}
          sorted by relevance
        </span>
      </div>
      <Table aria-label="Search results">
        <TableHeader>
          <TableRow>
            <TableHead>Key</TableHead>
            <TableHead>Kind</TableHead>
            <TableHead>Resource</TableHead>
            <TableHead>Produced</TableHead>
            <TableHead>Snippet</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.results.map((r) => (
            <TableRow key={r.r2_key}>
              <TableCell>
                <Link
                  to={`/p/${projectId}/artifacts/${r.r2_key}`}
                  className="rounded-sm text-signal-blue underline decoration-signal-blue/40 underline-offset-2 hover:text-signal-blue-hover hover:decoration-signal-blue focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal-blue"
                >
                  {r.r2_key}
                </Link>
              </TableCell>
              <TableCell>
                <Badge variant="secondary">{r.kind}</Badge>
              </TableCell>
              <TableCell className="text-foreground">
                {r.resource ?? "—"}
              </TableCell>
              <TableCell className="tila-num text-muted-foreground">
                {relativeTime(r.produced_at)}
              </TableCell>
              <TableCell>
                {r.snippet ? (
                  <span
                    className="text-xs text-foreground"
                    // biome-ignore lint/security/noDangerouslySetInnerHtml: FTS5 snippet with sanitized HTML (only <strong> tags)
                    dangerouslySetInnerHTML={{
                      __html: sanitizeSnippet(r.snippet),
                    }}
                  />
                ) : (
                  <span className="text-muted-foreground">{"—"}</span>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
