import { Badge } from "@/components/ui/badge";
import { CopyButton } from "@/components/ui/copy-button";
import { Drawer } from "@/components/ui/drawer";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { TableError } from "@/components/ui/table-error";
import { InfoTip } from "@/components/ui/tooltip";
import { useRecord, useRecordHistory, useRecords } from "@/hooks/use-api";
import { useAuth } from "@/hooks/use-auth";
import { useTimeTick } from "@/hooks/use-time-tick";
import { formatDateTime, relativeTime } from "@/lib/time";
import { ChevronDown, ChevronUp, Maximize2, Minimize2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <h2 className="tila-label">{children}</h2>;
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <TableCell className="w-40 font-sans text-sm font-medium text-muted-foreground">
      {children}
    </TableCell>
  );
}

function operationVariant(
  op: string,
): "green" | "amber" | "red" | "gray" | "default" {
  switch (op) {
    case "created":
      return "green";
    case "set":
    case "patch":
      return "amber";
    case "archived":
      return "red";
    case "unarchived":
      return "gray";
    default:
      return "default";
  }
}

export function RecordDetailPage() {
  useTimeTick();
  const params = useParams();
  const { projectId } = useAuth();
  const navigate = useNavigate();

  const type = params.type ?? "";
  const key = params["*"] ?? "";

  const {
    data: recordData,
    isLoading,
    isError,
    error,
    refetch,
  } = useRecord(type, key);
  const { data: historyData } = useRecordHistory(type, key, { limit: 20 });
  const { data: listData } = useRecords(type);

  const siblings = useMemo(() => {
    const items = listData?.items ?? [];
    const idx = items.findIndex((r) => r.key === key);
    return {
      prev: idx > 0 ? items[idx - 1] : null,
      next: idx >= 0 && idx < items.length - 1 ? items[idx + 1] : null,
      position: idx >= 0 ? idx + 1 : null,
      total: items.length,
    };
  }, [listData, key]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.ctrlKey || e.metaKey) return;
      const tag = document.activeElement?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.key === "j" || e.key === "ArrowDown") {
        if (siblings.next) {
          e.preventDefault();
          navigate(
            `/p/${projectId}/records/${siblings.next.type}/${siblings.next.key}`,
          );
        }
      } else if (e.key === "k" || e.key === "ArrowUp") {
        if (siblings.prev) {
          e.preventDefault();
          navigate(
            `/p/${projectId}/records/${siblings.prev.type}/${siblings.prev.key}`,
          );
        }
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [siblings, navigate, projectId]);

  const [expanded, setExpanded] = useState(false);
  const record = recordData?.record;
  const fence = recordData?.fence;
  const historyItems = historyData?.items ?? [];

  return (
    <Drawer
      onClose={() =>
        navigate(`/p/${projectId}/records?type=${encodeURIComponent(type)}`)
      }
      expanded={expanded}
      headerActions={
        <>
          <div className="flex items-center gap-0.5">
            <button
              type="button"
              disabled={!siblings.prev}
              onClick={() =>
                siblings.prev &&
                navigate(
                  `/p/${projectId}/records/${siblings.prev.type}/${siblings.prev.key}`,
                )
              }
              className="cursor-pointer rounded-sm p-1.5 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal-blue disabled:opacity-30 disabled:cursor-default"
              aria-label="Previous record (K / ↑)"
              title="Previous record (K / ↑)"
            >
              <ChevronUp size={16} />
            </button>
            <button
              type="button"
              disabled={!siblings.next}
              onClick={() =>
                siblings.next &&
                navigate(
                  `/p/${projectId}/records/${siblings.next.type}/${siblings.next.key}`,
                )
              }
              className="cursor-pointer rounded-sm p-1.5 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal-blue disabled:opacity-30 disabled:cursor-default"
              aria-label="Next record (J / ↓)"
              title="Next record (J / ↓)"
            >
              <ChevronDown size={16} />
            </button>
            {siblings.position && (
              <span className="px-1 font-mono text-[11px] text-fg-faint tabular-nums">
                {siblings.position}/{siblings.total}
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            className="cursor-pointer rounded-sm p-1.5 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal-blue"
            aria-label={expanded ? "Collapse" : "Expand"}
          >
            {expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
          </button>
        </>
      }
      title={
        <span className="flex items-center gap-1.5">
          <Link
            to={`/p/${projectId}/records?type=${encodeURIComponent(type)}`}
            className="text-muted-foreground hover:text-foreground"
          >
            Records
          </Link>
          <span className="text-muted-foreground">/</span>
          <Badge variant="gray">{type}</Badge>
          <span className="text-muted-foreground">/</span>
          <span className="font-mono">{key}</span>
        </span>
      }
    >
      <div className="space-y-6 px-6 py-4">
        {isLoading && (
          <p className="text-sm text-muted-foreground">Loading...</p>
        )}

        {isError && <TableError error={error} onRetry={() => refetch()} />}

        {record && (
          <>
            <section>
              <SectionLabel>Metadata</SectionLabel>
              <Table aria-label="Record metadata">
                <TableBody>
                  <TableRow>
                    <FieldLabel>Type</FieldLabel>
                    <TableCell>
                      <Badge variant="gray">{record.type}</Badge>
                    </TableCell>
                  </TableRow>
                  <TableRow>
                    <FieldLabel>Key</FieldLabel>
                    <TableCell>
                      <span className="inline-flex items-center gap-1.5">
                        <span className="font-mono text-sm">{record.key}</span>
                        <CopyButton value={record.key} />
                      </span>
                    </TableCell>
                  </TableRow>
                  <TableRow>
                    <FieldLabel>Revision</FieldLabel>
                    <TableCell className="font-mono text-sm tabular-nums">
                      {record.revision}
                    </TableCell>
                  </TableRow>
                  <TableRow>
                    <FieldLabel>
                      <InfoTip content="Schema version from tila.schema.toml when this record was last written">
                        Schema Version
                      </InfoTip>
                    </FieldLabel>
                    <TableCell className="font-mono text-sm tabular-nums">
                      {record.schema_version}
                    </TableCell>
                  </TableRow>
                  <TableRow>
                    <FieldLabel>Created</FieldLabel>
                    <TableCell className="text-sm">
                      {formatDateTime(record.created_at)}
                    </TableCell>
                  </TableRow>
                  <TableRow>
                    <FieldLabel>Updated</FieldLabel>
                    <TableCell className="text-sm">
                      {formatDateTime(record.updated_at)}
                    </TableCell>
                  </TableRow>
                  <TableRow>
                    <FieldLabel>Updated By</FieldLabel>
                    <TableCell className="font-mono text-sm">
                      {record.updated_by}
                    </TableCell>
                  </TableRow>
                  {fence !== undefined && (
                    <TableRow>
                      <FieldLabel>
                        <InfoTip content="Monotonic fencing token for concurrency control. Stale fences are rejected on writes.">
                          Fence
                        </InfoTip>
                      </FieldLabel>
                      <TableCell className="font-mono text-sm tabular-nums">
                        {fence}
                      </TableCell>
                    </TableRow>
                  )}
                  <TableRow>
                    <FieldLabel>
                      <InfoTip content="SHA-256 hash of the canonical JSON value. Used for content-addressing and deduplication.">
                        Value SHA256
                      </InfoTip>
                    </FieldLabel>
                    <TableCell>
                      <span className="inline-flex items-center gap-1.5">
                        <span className="font-mono text-xs text-muted-foreground">
                          {record.value_sha256.slice(0, 16)}...
                        </span>
                        <CopyButton value={record.value_sha256} />
                      </span>
                    </TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </section>

            <section>
              <SectionLabel>Tags</SectionLabel>
              {record.tags.length > 0 ? (
                <div className="flex flex-wrap gap-1.5 py-2">
                  {record.tags.map((tag) => (
                    <Badge key={tag} variant="gray">
                      {tag}
                    </Badge>
                  ))}
                </div>
              ) : (
                <p className="py-2 text-sm text-muted-foreground">No tags</p>
              )}
            </section>

            {record.archived === 1 && (
              <div className="rounded-md border border-status-red/30 bg-status-red/5 px-3 py-2">
                <Badge variant="red">Archived</Badge>
              </div>
            )}

            <section>
              <div className="flex items-center justify-between">
                <SectionLabel>Value</SectionLabel>
                <CopyButton value={JSON.stringify(record.value, null, 2)} />
              </div>
              <pre className="mt-2 max-h-[400px] overflow-auto rounded-md bg-card p-3 font-mono text-xs leading-relaxed text-foreground whitespace-pre-wrap break-all">
                {JSON.stringify(record.value, null, 2)}
              </pre>
            </section>

            <section>
              <SectionLabel>Revision History</SectionLabel>
              {historyItems.length === 0 ? (
                <p className="py-2 text-sm text-muted-foreground">
                  No history available
                </p>
              ) : (
                <Table aria-label="Revision history">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Revision</TableHead>
                      <TableHead>Operation</TableHead>
                      <TableHead>Actor</TableHead>
                      <TableHead>Time</TableHead>
                      <TableHead>Message</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {historyItems.map((item) => (
                      <TableRow key={item.revision}>
                        <TableCell className="font-mono text-xs tabular-nums">
                          {item.revision}
                        </TableCell>
                        <TableCell>
                          <Badge variant={operationVariant(item.operation)}>
                            {item.operation}
                          </Badge>
                        </TableCell>
                        <TableCell className="font-mono text-xs">
                          {item.actor}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {relativeTime(item.created_at)}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {item.message || "—"}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </section>
          </>
        )}
      </div>
    </Drawer>
  );
}
