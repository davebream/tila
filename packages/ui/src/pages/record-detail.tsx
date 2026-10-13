import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { Drawer } from "@/components/ui/drawer";
import {
  CollapsibleData,
  DefinitionsUnavailable,
  FieldLabel,
  FieldTable,
  MutedLine,
  dataRows,
} from "@/components/ui/field-table";
import {
  QuerySection,
  SectionFailure,
  StaleNotice,
} from "@/components/ui/query-section";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { InfoTip } from "@/components/ui/tooltip";
import { RecordEditForm } from "@/components/work/record-editor";
import { useWhoami } from "@/hooks/use-admin";
import {
  useRecord,
  useRecordHistory,
  useRecordPage,
  useRecordTypes,
} from "@/hooks/use-api";
import { useAuth } from "@/hooks/use-auth";
import { useTimeTick } from "@/hooks/use-time-tick";
import { type TypeDefinitions, resolveDefinitions } from "@/lib/presentation";
import { deriveSectionState } from "@/lib/query-state";
import { recordPageParams } from "@/lib/record-list";
import { rights } from "@/lib/rights";
import { formatDateTime, relativeTime } from "@/lib/time";
import { ClassificationBadge } from "@/pages/records";
import type { RecordCatalogEntry } from "@tila/schemas";
import { presentedText, presentedTitle } from "@tila/schemas";
import {
  ChevronDown,
  ChevronUp,
  Maximize2,
  Minimize2,
  Pencil,
} from "lucide-react";
import { type ReactNode, useEffect, useId, useMemo, useState } from "react";
import {
  Link,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router";

function DetailSection({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="space-y-2">
      <div className="flex items-center justify-between">
        <h2 id={headingId} className="tila-label">
          {title}
        </h2>
        {action}
      </div>
      {children}
    </section>
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
  const location = useLocation();
  const [searchParams] = useSearchParams();

  const type = params.type ?? "";
  const key = params["*"] ?? "";

  // Siblings come from the list page on screen behind the drawer, so J/K
  // walk the rows the viewer is looking at. Without list state for this
  // type, the first page in key order is used.
  const listSearch =
    searchParams.get("type") === type ? searchParams : new URLSearchParams();
  const listQuery = useRecordPage(type, recordPageParams(listSearch));
  const listLink = {
    pathname: `/p/${projectId}/records`,
    search: location.search || `?type=${encodeURIComponent(type)}`,
  };
  const recordLink = (t: string, k: string) => ({
    pathname: `/p/${projectId}/records/${t}/${k}`,
    search: location.search,
  });

  const recordQuery = useRecord(type, key);
  const historyQuery = useRecordHistory(type, key, { limit: 20 });
  const typesQuery = useRecordTypes();

  const siblings = useMemo(() => {
    const items = listQuery.data?.items ?? [];
    const idx = items.findIndex((r) => r.key === key);
    return {
      prev: idx > 0 ? items[idx - 1] : null,
      next: idx >= 0 && idx < items.length - 1 ? items[idx + 1] : null,
    };
  }, [listQuery.data, key]);

  const goTo = (sibling: { type: string; key: string } | null) => {
    if (sibling) {
      navigate(recordLink(sibling.type, sibling.key), {
        state: location.state,
      });
    }
  };

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.ctrlKey || e.metaKey) return;
      const tag = document.activeElement?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if ((e.key === "j" || e.key === "ArrowDown") && siblings.next) {
        e.preventDefault();
        goTo(siblings.next);
      } else if ((e.key === "k" || e.key === "ArrowUp") && siblings.prev) {
        e.preventDefault();
        goTo(siblings.prev);
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  });

  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const editHintId = useId();
  const whoami = useWhoami();
  const allowed = rights(whoami.data, projectId ?? "");
  const recordState = deriveSectionState(recordQuery);
  // A failed "Older revisions" request is reported beside the button; the
  // pages already loaded are still current.
  const historyState = deriveSectionState(
    historyQuery.isFetchNextPageError
      ? { ...historyQuery, status: "success" as const }
      : historyQuery,
    { isEmpty: (d) => (d.pages[0]?.items.length ?? 0) === 0 },
  );
  // Only a record that is currently readable is shown: after a 403/404 refresh
  // the query still holds the old record, which must not keep rendering.
  const recordData =
    recordState.phase === "ready" ? recordState.data : undefined;
  const record = recordData?.record;
  const fence = recordData?.fence;

  const defs: TypeDefinitions<RecordCatalogEntry> = resolveDefinitions(
    typesQuery.data && {
      entries: typesQuery.data.entries,
      incomplete: typesQuery.data.incomplete,
    },
    typesQuery.isError && !typesQuery.data,
    type,
  );
  const entry = defs.status === "declared" ? defs.entry : undefined;
  const definition = entry?.definition;
  const presentation = definition?.presentation;
  const value = record?.value ?? {};

  // Until definitions resolve the heading stays the key, so a presented title
  // never flashes in from the wrong field.
  const title =
    record && defs.status !== "pending"
      ? presentedTitle(record.value, presentation)
      : null;
  const summary = presentedText(value, presentation?.summary);
  const shownElsewhere = [presentation?.title, presentation?.summary].filter(
    (name): name is string => Boolean(name),
  );
  const declaredNames = (definition?.fields ?? []).map((f) => f.name);
  const otherRows =
    defs.status === "declared"
      ? dataRows(value, [...declaredNames, ...shownElsewhere])
      : defs.status === "undeclared"
        ? dataRows(value)
        : [];
  const showOtherFields =
    record !== undefined &&
    (defs.status === "undeclared" ||
      (defs.status === "declared" && otherRows.length > 0));

  const historyItems = historyQuery.data?.pages.flatMap((p) => p.items) ?? [];

  const editBlock: string | null =
    !record || defs.status === "pending" || !whoami.data
      ? "pending"
      : record.archived === 1
        ? "Archived records cannot be edited."
        : defs.status === "undeclared"
          ? `Type ${type} is not in the current schema, so its records are read-only here. Declare it in Settings → Definitions to edit them.`
          : defs.status !== "declared"
            ? "Field definitions are unavailable, so the editor cannot be built."
            : !allowed.writeRecord(type, key)
              ? "This credential cannot write this record."
              : null;

  return (
    <Drawer
      onClose={() => navigate(listLink, { state: location.state })}
      expanded={expanded}
      headerActions={
        <>
          <div className="flex items-center gap-0.5">
            <button
              type="button"
              disabled={!siblings.prev}
              onClick={() => goTo(siblings.prev)}
              className="cursor-pointer rounded-sm p-1.5 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal-blue disabled:opacity-30 disabled:cursor-default"
              aria-label="Previous record (K / ↑)"
              title="Previous record (K / ↑)"
            >
              <ChevronUp size={16} />
            </button>
            <button
              type="button"
              disabled={!siblings.next}
              onClick={() => goTo(siblings.next)}
              className="cursor-pointer rounded-sm p-1.5 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal-blue disabled:opacity-30 disabled:cursor-default"
              aria-label="Next record (J / ↓)"
              title="Next record (J / ↓)"
            >
              <ChevronDown size={16} />
            </button>
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
      title={title ?? <span className="font-mono">{key}</span>}
    >
      <div className="space-y-6 px-6 py-4">
        <div className="flex flex-wrap items-center gap-2">
          <Link
            to={listLink}
            state={location.state}
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            Records
          </Link>
          <span className="text-muted-foreground">/</span>
          <Badge variant="gray">{type}</Badge>
          <span className="text-muted-foreground">/</span>
          <span className="font-mono text-sm text-foreground">{key}</span>
          <CopyButton value={key} />
          {defs.status === "undeclared" && (
            <Badge
              variant="amber"
              title="The current schema does not declare this type"
            >
              Not in schema
            </Badge>
          )}
          <ClassificationBadge entry={entry} />
          {record?.archived === 1 && <Badge variant="red">Archived</Badge>}
        </div>

        {!editing && editBlock !== "pending" && (
          <div className="space-y-1">
            <Button
              size="sm"
              variant="outline"
              disabled={editBlock !== null}
              aria-describedby={editBlock ? editHintId : undefined}
              onClick={() => setEditing(true)}
            >
              <Pencil aria-hidden="true" />
              Edit
            </Button>
            {editBlock && (
              <p id={editHintId} className="text-xs text-muted-foreground">
                {editBlock}
              </p>
            )}
          </div>
        )}
        {editing &&
          record &&
          definition &&
          fence !== undefined &&
          whoami.data?.principal_id && (
            <section className="space-y-3" aria-label="Edit record">
              <h2 className="tila-label">Edit record</h2>
              <RecordEditForm
                record={record}
                fence={fence}
                definition={definition}
                principal={whoami.data.principal_id}
                onClose={() => setEditing(false)}
              />
            </section>
          )}

        {recordState.phase === "pending" && (
          <output className="block text-sm text-muted-foreground">
            Loading record…
          </output>
        )}

        {recordState.phase === "failed" && (
          <SectionFailure
            kind={recordState.kind}
            error={recordState.error}
            label="record"
            onRetry={() => void recordQuery.refetch()}
          />
        )}

        {recordState.phase === "ready" && recordState.stale && (
          <StaleNotice
            label="record"
            updatedAt={recordState.updatedAt}
            stale={recordState.stale}
            onRetry={() => void recordQuery.refetch()}
          />
        )}

        {record && (
          <>
            {summary && (
              <DetailSection title="Summary">
                <p className="whitespace-pre-wrap text-sm text-foreground">
                  {summary}
                </p>
              </DetailSection>
            )}

            <DetailSection title="Fields">
              {defs.status === "pending" ? (
                <MutedLine>Loading field definitions…</MutedLine>
              ) : defs.status === "unavailable" ? (
                <>
                  <DefinitionsUnavailable
                    onRetry={
                      typesQuery.isError
                        ? () => void typesQuery.refetch()
                        : undefined
                    }
                  />
                  {Object.keys(value).length > 0 ? (
                    <FieldTable label="Record fields" rows={dataRows(value)} />
                  ) : (
                    <MutedLine>No stored data.</MutedLine>
                  )}
                </>
              ) : defs.status === "undeclared" ? (
                <MutedLine>No fields are declared for this type.</MutedLine>
              ) : (
                (() => {
                  const declared = (definition?.fields ?? []).filter(
                    (f) => !shownElsewhere.includes(f.name),
                  );
                  return declared.length > 0 ? (
                    <FieldTable
                      label="Record fields"
                      rows={declared.map((f) => ({
                        name: f.name,
                        type: f.type,
                        value: value[f.name],
                      }))}
                    />
                  ) : (
                    <MutedLine>No other declared fields.</MutedLine>
                  );
                })()
              )}
            </DetailSection>

            {showOtherFields && (
              <DetailSection title="Other fields">
                <MutedLine>
                  {defs.status === "undeclared" ? (
                    <>
                      Type <code className="font-mono">{type}</code> is not in
                      the current schema. Stored data is shown as-is.
                    </>
                  ) : (
                    <>
                      Not declared by the{" "}
                      <code className="font-mono">{type}</code> schema.
                    </>
                  )}
                </MutedLine>
                {otherRows.length > 0 ? (
                  <FieldTable label="Other fields" rows={otherRows} />
                ) : (
                  <MutedLine>No stored data.</MutedLine>
                )}
              </DetailSection>
            )}

            <DetailSection title="Tags">
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
            </DetailSection>

            <DetailSection title="Metadata">
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
            </DetailSection>

            <DetailSection
              title="Value"
              action={
                <CopyButton value={JSON.stringify(record.value, null, 2)} />
              }
            >
              <CollapsibleData data={record.value} noun="value" />
            </DetailSection>

            <DetailSection title="Revision History">
              <QuerySection
                state={historyState}
                label="revision history"
                empty="No history available"
                onRetry={() => void historyQuery.refetch()}
              >
                {() => (
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
                          <TableCell
                            className="text-muted-foreground"
                            title={formatDateTime(item.created_at)}
                          >
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
              </QuerySection>
              {historyState.phase === "ready" && historyQuery.hasNextPage && (
                <div className="flex flex-wrap items-center gap-3">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={historyQuery.isFetchingNextPage}
                    onClick={() => void historyQuery.fetchNextPage()}
                  >
                    {historyQuery.isFetchingNextPage
                      ? "Loading older revisions…"
                      : "Older revisions"}
                  </Button>
                  {historyQuery.isFetchNextPageError && (
                    <span className="text-xs text-status-red">
                      Could not load older revisions.
                    </span>
                  )}
                </div>
              )}
            </DetailSection>
          </>
        )}
      </div>
    </Drawer>
  );
}
