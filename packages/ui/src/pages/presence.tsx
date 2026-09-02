import { LastRefreshed } from "@/components/ui/last-refreshed";
import { PresenceDot } from "@/components/ui/presence-dot";
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
import { usePresence } from "@/hooks/use-api";
import { useTableKeyNav } from "@/hooks/use-table-key-nav";
import { useTimeTick } from "@/hooks/use-time-tick";
import { relativeTime } from "@/lib/time";
import { useEffect, useMemo } from "react";
import { useSearchParams } from "react-router";

function deriveStatus(active: boolean): "active" | "idle" | "lost" {
  return active ? "active" : "idle";
}

function parseSortPresence(
  raw: string | null,
): { key: "participant_id" | "last_seen"; dir: "asc" | "desc" } | null {
  if (!raw) return null;
  const [k, d] = raw.split(":");
  if (
    ["participant_id", "last_seen"].includes(k) &&
    (d === "asc" || d === "desc")
  ) {
    return { key: k as "participant_id" | "last_seen", dir: d };
  }
  return null;
}

export function PresencePage() {
  useTimeTick();
  const { data, isLoading, isError, error, refetch, dataUpdatedAt } =
    usePresence();
  const participants = data?.participants ?? [];
  const [searchParams, setSearchParams] = useSearchParams();
  const [sort, toggleSort] = useSort<"participant_id" | "last_seen">(
    parseSortPresence(searchParams.get("sort")) ?? {
      key: "last_seen",
      dir: "desc",
    },
  );

  useEffect(() => {
    const params = new URLSearchParams();
    if (sort) params.set("sort", `${sort.key}:${sort.dir}`);
    setSearchParams(params, { replace: true });
  }, [sort, setSearchParams]);

  const sorted = useMemo(() => {
    const base = [...participants];
    if (!sort) {
      return base.sort((a, b) => {
        if (a.active !== b.active) return a.active ? -1 : 1;
        return b.last_seen - a.last_seen;
      });
    }
    const dir = sort.dir === "asc" ? 1 : -1;
    return base.sort((a, b) => {
      if (a.active !== b.active) return a.active ? -1 : 1;
      switch (sort.key) {
        case "participant_id":
          return a.participant_id.localeCompare(b.participant_id) * dir;
        case "last_seen":
          return (a.last_seen - b.last_seen) * dir;
        default:
          return 0;
      }
    });
  }, [participants, sort]);

  const { focusIdx, handleKeyDown: handleTableKeyDown } = useTableKeyNav(
    sorted.length,
  );

  return (
    <div className="space-y-4 p-3 md:p-6">
      <div className="flex items-center gap-3">
        <h1 className="font-logo text-xl tracking-tight text-foreground">
          Presence
        </h1>
        {sorted.length > 0 && (
          <span className="tila-num rounded-full border border-border bg-card px-[7px] py-px font-mono text-[11px] text-fg-faint">
            {sorted.length}
          </span>
        )}
        <LastRefreshed dataUpdatedAt={dataUpdatedAt} />
      </div>

      {isError ? (
        <TableError error={error} onRetry={() => refetch()} />
      ) : isLoading ? (
        <div className="overflow-hidden rounded-lg border border-border">
          <Table aria-label="Presence">
            <TableHeader>
              <TableRow>
                <TableHead className="w-[26px]" />
                <TableHead>Participant</TableHead>
                <TableHead>Principal</TableHead>
                <TableHead className="text-right">Last Seen</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableSkeleton rows={3} columns={4} />
            </TableBody>
          </Table>
        </div>
      ) : sorted.length === 0 ? (
        <p className="py-12 text-center text-muted-foreground">
          No participants registered. Participants appear when clients send
          heartbeats.
        </p>
      ) : (
        <div
          className="overflow-hidden rounded-lg border border-border focus-visible:outline-none"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard row navigation
          // biome-ignore lint/a11y/useSemanticElements: div wraps table for keyboard nav
          tabIndex={0}
          role="grid"
          onKeyDown={handleTableKeyDown}
        >
          <Table aria-label="Presence">
            <TableHeader>
              <TableRow>
                <TableHead className="w-[26px]" />
                <SortableHead
                  sortKey="participant_id"
                  active={sort?.key === "participant_id"}
                  dir={sort?.key === "participant_id" ? sort.dir : null}
                  onSort={() => toggleSort("participant_id")}
                  title="Independent client session identifier"
                >
                  Participant
                </SortableHead>
                <TableHead>Principal</TableHead>
                <SortableHead
                  sortKey="last_seen"
                  active={sort?.key === "last_seen"}
                  dir={sort?.key === "last_seen" ? sort.dir : null}
                  onSort={() => toggleSort("last_seen")}
                  className="text-right"
                  title="Most recent heartbeat from this participant"
                >
                  Last Seen
                </SortableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sorted.map((participant, idx) => {
                const status = deriveStatus(participant.active);
                return (
                  <TableRow
                    key={`${participant.principal_id}:${participant.participant_id}`}
                    className={
                      idx === focusIdx ? "bg-[var(--color-row-hover)]" : ""
                    }
                  >
                    <TableCell>
                      <PresenceDot status={status} />
                    </TableCell>
                    <TableCell className="text-fg-strong">
                      <div className="font-mono text-xs">
                        {participant.participant_id}
                      </div>
                      {participant.environment.machine && (
                        <div className="text-xs text-muted-foreground">
                          {participant.environment.machine}
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="font-mono text-xs text-fg-strong">
                      {participant.principal_id}
                    </TableCell>
                    <TableCell className="tila-num text-right text-muted-foreground">
                      {relativeTime(participant.last_seen)}
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
            <kbd className="font-mono">j</kbd>/
            <kbd className="font-mono">k</kbd> navigate{" "}
            <kbd className="font-mono">⌘K</kbd> search
          </p>
        </div>
      )}
    </div>
  );
}
