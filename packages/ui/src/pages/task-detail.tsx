import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { Drawer } from "@/components/ui/drawer";
import { QuerySection } from "@/components/ui/query-section";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { InfoTip } from "@/components/ui/tooltip";
import {
  useClaims,
  useTask,
  useTaskArtifactRefs,
  useTaskHistory,
  useWorkCatalog,
} from "@/hooks/use-api";
import { useAuth } from "@/hooks/use-auth";
import { useTimeTick } from "@/hooks/use-time-tick";
import { taskState } from "@/lib/presentation";
import { type SectionState, deriveSectionState } from "@/lib/query-state";
import { formatDateTime, relativeTime } from "@/lib/time";
import type {
  CatalogField,
  JournalResponse,
  StateListResponse,
  WorkCatalogEntry,
  WorkCatalogResponse,
} from "@tila/schemas";
import { presentedText, presentedTitle } from "@tila/schemas";
import { ChevronRight, Maximize2, Minimize2 } from "lucide-react";
import { type ReactNode, useId, useMemo, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router";

const dataLinkClass =
  "rounded-sm text-signal-blue underline decoration-signal-blue/40 underline-offset-2 hover:text-signal-blue-hover hover:decoration-signal-blue focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal-blue";

type Claim = StateListResponse["claims"][number];

function TaskSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="space-y-3">
      <h2 id={headingId} className="tila-label">
        {title}
      </h2>
      {children}
    </section>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <TableCell className="w-40 font-sans text-sm font-medium text-muted-foreground">
      {children}
    </TableCell>
  );
}

function claimExpiryClass(expiresAt: number): string {
  const msLeft = expiresAt - Date.now();
  if (msLeft <= 0) return "text-status-red";
  if (msLeft < 5 * 60 * 1000) return "text-status-amber";
  return "text-muted-foreground";
}

function claimExpiryLabel(expiresAt: number): string {
  const msLeft = expiresAt - Date.now();
  if (msLeft <= 0) return `Expired (${formatDateTime(expiresAt)})`;
  if (msLeft < 5 * 60 * 1000) {
    const secsLeft = Math.ceil(msLeft / 1000);
    const mins = Math.floor(secsLeft / 60);
    const secs = secsLeft % 60;
    return `${mins}m ${secs}s remaining`;
  }
  return formatDateTime(expiresAt);
}

// A task's bare route id (e.g. "task.ingest-worker") must match a claim whose
// `resource` is either the bare id or the canonical typed form "<type>:<id>"
// (produced by ops-sqlite/fence-ops.ts, returned by GET /claims). The type prefix
// is the entity's actual type — "task" for tasks, "epic"/"milestone" for those
// entity kinds, all reachable via the shared /tasks/:id drawer.
export function claimResourceMatchesEntity(
  resource: string,
  entityId: string,
  entityType?: string,
): boolean {
  if (entityId === "") return false;
  if (resource === entityId) return true;
  if (entityType && resource === `${entityType}:${entityId}`) return true;
  return false;
}

function CollapsibleData({ data }: { data: Record<string, unknown> }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex cursor-pointer items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <ChevronRight
          size={14}
          className={`transition-transform duration-150 ${open ? "rotate-90" : ""}`}
        />
        Show data ({Object.keys(data).length} keys)
      </button>
      {open && (
        <pre className="mt-2 overflow-x-auto rounded-md bg-background p-3 text-xs text-foreground whitespace-pre-wrap break-all">
          {JSON.stringify(data, null, 2)}
        </pre>
      )}
    </div>
  );
}

/**
 * What the current schema says about this task's type.
 * `unavailable`: the catalog failed, or it could not read definitions.
 * `undeclared`: the schema does not declare the type; stored data stays readable.
 */
type TypeDefinitions =
  | { status: "pending" }
  | { status: "unavailable" }
  | { status: "undeclared" }
  | { status: "declared"; entry: WorkCatalogEntry };

export function resolveDefinitions(
  catalog: WorkCatalogResponse | undefined,
  catalogFailed: boolean,
  type: string,
): TypeDefinitions {
  if (!catalog) return { status: catalogFailed ? "unavailable" : "pending" };
  const entry = catalog.types.find((e) => e.type === type);
  if (!entry) {
    // A type missing from a complete catalog is not declared by the schema.
    return catalog.incomplete?.declared_types
      ? { status: "unavailable" }
      : { status: "undeclared" };
  }
  if (entry.declaration === "declared") return { status: "declared", entry };
  if (entry.declaration === "undeclared") return { status: "undeclared" };
  return { status: "unavailable" };
}

/** Data keys never listed as fields: shown elsewhere in the drawer. */
const STRUCTURAL_KEYS = new Set(["parent_id"]);

function NotSet() {
  return <span className="font-sans text-muted-foreground">Not set</span>;
}

/**
 * One stored value, rendered by its declared type. A value whose shape does
 * not match the declaration is shown as stored rather than coerced.
 */
function FieldValue({ value, type }: { value: unknown; type?: string }) {
  if (value === undefined || value === null) return <NotSet />;
  if (typeof value === "string") {
    if (value === "") {
      return <span className="font-sans text-muted-foreground">Empty</span>;
    }
    if (type === "enum") return <Badge variant="gray">{value}</Badge>;
    if (type === "text") {
      return (
        <span className="whitespace-pre-wrap font-sans text-foreground">
          {value}
        </span>
      );
    }
    return (
      <span className="whitespace-pre-wrap break-words text-foreground">
        {value}
      </span>
    );
  }
  if (typeof value === "number") {
    return <span className="tila-num text-foreground">{value}</span>;
  }
  if (typeof value === "boolean") {
    return <span className="text-foreground">{value ? "Yes" : "No"}</span>;
  }
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
    if (value.length === 0) {
      return <span className="font-sans text-muted-foreground">None</span>;
    }
    return (
      <span className="flex flex-wrap gap-1">
        {value.map((item, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: list items may repeat
          <Badge key={`${item}-${i}`} variant="secondary">
            {item}
          </Badge>
        ))}
      </span>
    );
  }
  return (
    <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-md bg-background p-2 text-xs text-foreground">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

function FieldTable({
  label,
  rows,
}: {
  label: string;
  rows: { name: string; value: unknown; type?: string }[];
}) {
  return (
    <div className="border-t border-border">
      <Table aria-label={label}>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.name}>
              <FieldLabel>
                <span className="font-mono">{row.name}</span>
              </FieldLabel>
              <TableCell>
                <FieldValue value={row.value} type={row.type} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function MutedLine({ children }: { children: ReactNode }) {
  return <p className="text-sm text-muted-foreground">{children}</p>;
}

function DefinitionsUnavailable({ onRetry }: { onRetry?: () => void }) {
  return (
    <p className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md bg-tint-amber px-3 py-2 text-xs text-status-amber">
      <span>
        Field definitions unavailable. Stored data is shown without its schema.
      </span>
      {onRetry && (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={onRetry}
          className="font-mono text-muted-foreground"
        >
          Retry
        </Button>
      )}
    </p>
  );
}

function dataRows(data: Record<string, unknown>, exclude: Set<string>) {
  return Object.keys(data)
    .filter((key) => !exclude.has(key) && !STRUCTURAL_KEYS.has(key))
    .map((key) => ({ name: key, value: data[key] }));
}

type HistoryEvent = JournalResponse["events"][number];

function HistoryTable({ events }: { events: HistoryEvent[] }) {
  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <Table aria-label="Task history">
        <TableHeader>
          <TableRow>
            <TableHead>Event</TableHead>
            <TableHead>Actor</TableHead>
            <TableHead className="text-right">When</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {events.map((event) => (
            <TableRow key={event.seq}>
              <TableCell className="text-foreground">{event.kind}</TableCell>
              <TableCell className="text-muted-foreground">
                {event.principal_id}
              </TableCell>
              <TableCell
                className="tila-num text-right text-muted-foreground"
                title={formatDateTime(event.t)}
              >
                {relativeTime(event.t)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

export function TaskDetailPage() {
  useTimeTick();
  const { id } = useParams<{ id: string }>();
  const { projectId } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const entityId = id ?? "";
  // The list behind the drawer is driven by the query string and page trail;
  // keep both so closing returns to the same filtered page.
  const listLink = {
    pathname: `/p/${projectId}/tasks`,
    search: location.search,
  };
  const taskLink = (taskId: string) => ({
    pathname: `/p/${projectId}/tasks/${taskId}`,
    search: location.search,
  });

  const taskQuery = useTask(entityId);
  const catalogQuery = useWorkCatalog();
  const claimsQuery = useClaims();
  const refsQuery = useTaskArtifactRefs(entityId);

  const [expanded, setExpanded] = useState(false);

  // Fields and Relationships both come from the task query, so a task failure
  // must reach both. Each section is otherwise derived from its own request.
  const fieldsState = deriveSectionState(taskQuery);
  const entity = fieldsState.phase === "ready" ? fieldsState.data.entity : null;
  const historyQuery = useTaskHistory(entityId, entity?.type);

  const defs: TypeDefinitions = entity
    ? resolveDefinitions(
        catalogQuery.data,
        catalogQuery.isError && !catalogQuery.data,
        entity.type,
      )
    : { status: "pending" };
  const definition =
    defs.status === "declared" ? defs.entry.definition : undefined;
  const presentation = definition?.presentation;
  const data = entity?.data ?? {};

  // Until definitions resolve the heading stays the id, so a presented title
  // never flashes in from the wrong field.
  const title =
    entity && defs.status !== "pending"
      ? presentedTitle(entity.data, presentation)
      : null;
  const state =
    entity && defs.status !== "pending"
      ? taskState(
          entity.data,
          defs.status === "declared" ? defs.entry : undefined,
        )
      : null;
  const summary = presentedText(data, presentation?.summary);
  const description = presentedText(data, presentation?.description);

  // Declared fields already shown as the heading, summary, description or
  // state badge are not repeated in the field table.
  const shownElsewhere = useMemo(
    () =>
      new Set(
        [
          presentation?.title,
          presentation?.summary,
          presentation?.description,
          definition?.lifecycle?.field,
        ].filter((name): name is string => Boolean(name)),
      ),
    [presentation, definition],
  );

  const parentId =
    typeof data.parent_id === "string" && data.parent_id !== ""
      ? data.parent_id
      : null;
  const relationshipsState = deriveSectionState(taskQuery, {
    isEmpty: (d) =>
      (d.relationships ?? []).length === 0 &&
      !(typeof d.entity.data.parent_id === "string" && d.entity.data.parent_id),
  });
  const refsState = deriveSectionState(refsQuery, {
    isEmpty: (d) => d.references.length === 0,
  });

  const findClaim = (d: StateListResponse): Claim | undefined =>
    d.claims.find((c) =>
      claimResourceMatchesEntity(c.resource, entityId, entity?.type),
    );
  const claimsState = deriveSectionState(claimsQuery, {
    isEmpty: (d) => findClaim(d) === undefined,
  });
  // The typed "<type>:<id>" claim form can only be matched once the task type is
  // known, so "no match" is not trustworthy until the task query has resolved.
  // History is requested by both resource forms, so it waits for the type too.
  function afterTask<T>(own: SectionState<T>): SectionState<T> {
    if (fieldsState.phase === "pending") {
      return { phase: "pending", paused: fieldsState.paused };
    }
    if (fieldsState.phase === "failed") {
      return {
        phase: "failed",
        kind: fieldsState.kind,
        error: fieldsState.error,
      };
    }
    return own;
  }
  const claimState = afterTask(claimsState);
  const historyState = afterTask(
    deriveSectionState(historyQuery, { isEmpty: (d) => d.events.length === 0 }),
  );

  // When the task itself is gone or off limits, claims/artifacts/relationships
  // describe a subject the viewer cannot see, so they are not shown at all.
  const subjectUnavailable =
    fieldsState.phase === "failed" &&
    (fieldsState.kind === "forbidden" ||
      fieldsState.kind === "not-found" ||
      fieldsState.kind === "unauthenticated");

  const retryTask = () => void taskQuery.refetch();
  const retryCatalog = () => void catalogQuery.refetch();
  const retryClaims = () => {
    if (fieldsState.phase !== "ready") void taskQuery.refetch();
    void claimsQuery.refetch();
  };
  const retryHistory = () => {
    if (fieldsState.phase !== "ready") void taskQuery.refetch();
    void historyQuery.refetch();
  };
  const retryRefs = () => void refsQuery.refetch();

  const otherKeys =
    defs.status === "declared"
      ? new Set([
          ...(definition?.fields ?? []).map((f) => f.name),
          ...shownElsewhere,
        ])
      : new Set<string>();
  const otherRows =
    defs.status === "declared" || defs.status === "undeclared"
      ? dataRows(data, otherKeys)
      : [];
  const showOtherFields =
    entity !== null &&
    (defs.status === "undeclared" ||
      (defs.status === "declared" && otherRows.length > 0));

  return (
    <Drawer
      onClose={() => navigate(listLink, { state: location.state })}
      expanded={expanded}
      headerActions={
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="cursor-pointer rounded-sm p-1.5 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal-blue"
          aria-label={expanded ? "Collapse" : "Expand"}
        >
          {expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
        </button>
      }
      title={title ?? <span className="font-mono">{entityId}</span>}
    >
      <div className="space-y-8 p-6">
        <div className="flex flex-wrap items-center gap-2">
          <Link
            to={listLink}
            state={location.state}
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            Tasks
          </Link>
          <span className="text-muted-foreground">/</span>
          <span className="font-mono text-sm text-foreground">{entityId}</span>
          <CopyButton value={entityId} />
          {entity && <Badge variant="secondary">{entity.type}</Badge>}
          {entity && defs.status === "undeclared" && (
            <Badge
              variant="amber"
              title="The current schema does not declare this type"
            >
              Not in schema
            </Badge>
          )}
          {state && <Badge variant={state.variant}>{state.value}</Badge>}
        </div>
        <Link
          className={dataLinkClass}
          to={`/p/${projectId}/queue?task_id=${encodeURIComponent(id ?? "")}`}
        >
          View or enroll in queue
        </Link>

        {!subjectUnavailable && summary && (
          <TaskSection title="Summary">
            <p className="whitespace-pre-wrap text-sm text-foreground">
              {summary}
            </p>
          </TaskSection>
        )}
        {!subjectUnavailable && description && (
          <TaskSection title="Description">
            <p className="whitespace-pre-wrap text-sm text-foreground">
              {description}
            </p>
          </TaskSection>
        )}

        <TaskSection title="Fields">
          <QuerySection
            state={fieldsState}
            label="task data"
            empty="Task not found."
            notFound="Task not found."
            onRetry={retryTask}
          >
            {({ entity: task }) => {
              if (defs.status === "pending") {
                return <MutedLine>Loading field definitions…</MutedLine>;
              }
              if (defs.status === "unavailable") {
                const rows = dataRows(task.data, new Set());
                return (
                  <>
                    <DefinitionsUnavailable
                      onRetry={catalogQuery.isError ? retryCatalog : undefined}
                    />
                    {rows.length > 0 ? (
                      <FieldTable label="Task fields" rows={rows} />
                    ) : (
                      <MutedLine>No stored data.</MutedLine>
                    )}
                  </>
                );
              }
              if (defs.status === "undeclared") {
                return (
                  <MutedLine>No fields are declared for this type.</MutedLine>
                );
              }
              const declared = (definition?.fields ?? []).filter(
                (f: CatalogField) => !shownElsewhere.has(f.name),
              );
              if (declared.length === 0) {
                return <MutedLine>No other declared fields.</MutedLine>;
              }
              return (
                <FieldTable
                  label="Task fields"
                  rows={declared.map((f) => ({
                    name: f.name,
                    type: f.type,
                    value: task.data[f.name],
                  }))}
                />
              );
            }}
          </QuerySection>
        </TaskSection>

        {!subjectUnavailable && (
          <>
            {showOtherFields && entity && (
              <TaskSection title="Other fields">
                <MutedLine>
                  {defs.status === "undeclared" ? (
                    <>
                      Type <code className="font-mono">{entity.type}</code> is
                      not in the current schema. Stored data is shown as-is.
                    </>
                  ) : (
                    <>
                      Not declared by the{" "}
                      <code className="font-mono">{entity.type}</code> schema.
                    </>
                  )}
                </MutedLine>
                {otherRows.length > 0 ? (
                  <FieldTable label="Other fields" rows={otherRows} />
                ) : (
                  <MutedLine>No stored data.</MutedLine>
                )}
              </TaskSection>
            )}

            <TaskSection title="Relationships">
              <QuerySection
                state={relationshipsState}
                label="relationships"
                empty="No relationships."
                onRetry={retryTask}
              >
                {({ relationships }) => {
                  // `data.parent_id` is shown unless a parent-child edge
                  // already links the same pair.
                  const parentListed =
                    parentId !== null &&
                    relationships.some(
                      (rel) =>
                        rel.type === "parent-child" &&
                        ((rel.from_id === parentId && rel.to_id === entityId) ||
                          (rel.from_id === entityId && rel.to_id === parentId)),
                    );
                  return (
                    <div className="overflow-hidden rounded-lg border border-border">
                      <Table aria-label="Task relationships">
                        <TableHeader>
                          <TableRow>
                            <TableHead>
                              <InfoTip content="Relationship kind between two tasks (e.g. depends_on, blocks)">
                                Type
                              </InfoTip>
                            </TableHead>
                            <TableHead>From</TableHead>
                            <TableHead>To</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {parentId !== null && !parentListed && (
                            <TableRow>
                              <TableCell>
                                <Badge variant="secondary">Parent</Badge>
                              </TableCell>
                              <TableCell>
                                <Link
                                  to={taskLink(parentId)}
                                  state={location.state}
                                  className={dataLinkClass}
                                >
                                  {parentId}
                                </Link>
                              </TableCell>
                              <TableCell className="text-foreground">
                                {entityId}
                              </TableCell>
                            </TableRow>
                          )}
                          {relationships.map((rel) => (
                            <TableRow
                              key={`${rel.type}-${rel.from_id}-${rel.to_id}`}
                            >
                              <TableCell>
                                <Badge variant="secondary">{rel.type}</Badge>
                              </TableCell>
                              <TableCell>
                                <Link
                                  to={taskLink(rel.from_id)}
                                  state={location.state}
                                  className={dataLinkClass}
                                >
                                  {rel.from_id}
                                </Link>
                              </TableCell>
                              <TableCell>
                                <Link
                                  to={taskLink(rel.to_id)}
                                  state={location.state}
                                  className={dataLinkClass}
                                >
                                  {rel.to_id}
                                </Link>
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  );
                }}
              </QuerySection>
            </TaskSection>

            <TaskSection title="Artifacts">
              <QuerySection
                state={refsState}
                label="artifacts"
                empty="No artifacts attached."
                forbidden="Artifacts are not available to this credential."
                onRetry={retryRefs}
              >
                {({ references }) => (
                  <div className="overflow-hidden rounded-lg border border-border">
                    <Table aria-label="Task artifacts">
                      <TableHeader>
                        <TableRow>
                          <TableHead>
                            <InfoTip content="Named attachment point on the task">
                              Slot
                            </InfoTip>
                          </TableHead>
                          <TableHead>Artifact Key</TableHead>
                          <TableHead>Created</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {references.map((ref) => (
                          <TableRow key={`${ref.slot}-${ref.artifact_key}`}>
                            <TableCell className="text-foreground">
                              {ref.slot}
                            </TableCell>
                            <TableCell>
                              <Link
                                to={`/p/${projectId}/artifacts/${ref.artifact_key}`}
                                className={dataLinkClass}
                              >
                                {ref.artifact_key}
                              </Link>
                            </TableCell>
                            <TableCell className="tila-num text-muted-foreground">
                              {formatDateTime(ref.created_at)}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </QuerySection>
            </TaskSection>

            <TaskSection title="History">
              <QuerySection
                state={historyState}
                label="history"
                empty="No history recorded."
                forbidden="History is not available to this credential."
                onRetry={retryHistory}
              >
                {({ events }) => <HistoryTable events={events} />}
              </QuerySection>
              {historyState.phase === "ready" && (
                <Link
                  to={`/p/${projectId}/journal?resource=${encodeURIComponent(entityId)}`}
                  className={`text-xs ${dataLinkClass}`}
                >
                  Open in Journal
                </Link>
              )}
            </TaskSection>
            <TaskSection title="Claim State">
              <QuerySection
                state={claimState}
                label="claim state"
                empty="Not claimed."
                forbidden="You do not have access to claim state."
                onRetry={retryClaims}
              >
                {(claims) => {
                  const entityClaim = findClaim(claims);
                  if (!entityClaim) return null;
                  return (
                    <div className="overflow-hidden rounded-lg border border-border">
                      <Table aria-label="Claim state">
                        <TableBody>
                          <TableRow>
                            <FieldLabel>
                              <InfoTip content="Authenticated subject that owns this claim">
                                Principal
                              </InfoTip>
                            </FieldLabel>
                            <TableCell className="text-foreground">
                              {entityClaim.principal_id}
                            </TableCell>
                          </TableRow>
                          <TableRow>
                            <FieldLabel>Participant</FieldLabel>
                            <TableCell className="text-foreground">
                              {entityClaim.participant_id}
                            </TableCell>
                          </TableRow>
                          <TableRow>
                            <FieldLabel>
                              <InfoTip content="Claim mode. exclusive: sole holder, any competing claim is refused. owner: held by one principal, other principals are refused. presence: advisory, does not block a competing non-exclusive claim.">
                                Mode
                              </InfoTip>
                            </FieldLabel>
                            <TableCell className="text-foreground">
                              {entityClaim.mode}
                            </TableCell>
                          </TableRow>
                          <TableRow>
                            <FieldLabel>
                              <InfoTip content="Monotonic token that validates write ordering. Stale fences are rejected.">
                                Fence
                              </InfoTip>
                            </FieldLabel>
                            <TableCell className="tila-num text-foreground">
                              {entityClaim.fence}
                            </TableCell>
                          </TableRow>
                          <TableRow>
                            <FieldLabel>Acquired At</FieldLabel>
                            <TableCell
                              className="tila-num text-muted-foreground"
                              title={formatDateTime(entityClaim.acquired_at)}
                            >
                              {relativeTime(entityClaim.acquired_at)}
                            </TableCell>
                          </TableRow>
                          <TableRow>
                            <FieldLabel>Expires At</FieldLabel>
                            <TableCell
                              className={`tila-num ${claimExpiryClass(entityClaim.expires_at)}`}
                            >
                              {claimExpiryLabel(entityClaim.expires_at)}
                            </TableCell>
                          </TableRow>
                        </TableBody>
                      </Table>
                    </div>
                  );
                }}
              </QuerySection>
            </TaskSection>

            {entity && (
              <TaskSection title="Technical details">
                <div className="border-t border-border">
                  <Table aria-label="Technical details">
                    <TableBody>
                      <TableRow>
                        <FieldLabel>Type</FieldLabel>
                        <TableCell className="text-foreground">
                          {entity.type}
                        </TableCell>
                      </TableRow>
                      <TableRow>
                        <FieldLabel>
                          <InfoTip content="Data schema revision applied to this task">
                            Schema Version
                          </InfoTip>
                        </FieldLabel>
                        <TableCell className="tila-num text-foreground">
                          {entity.schema_version}
                        </TableCell>
                      </TableRow>
                      <TableRow>
                        <FieldLabel>Created By</FieldLabel>
                        <TableCell className="text-foreground">
                          {entity.created_by}
                        </TableCell>
                      </TableRow>
                      <TableRow>
                        <FieldLabel>Created At</FieldLabel>
                        <TableCell className="tila-num text-muted-foreground">
                          {formatDateTime(entity.created_at)}
                        </TableCell>
                      </TableRow>
                      <TableRow>
                        <FieldLabel>Updated At</FieldLabel>
                        <TableCell className="tila-num text-muted-foreground">
                          {formatDateTime(entity.updated_at)}
                        </TableCell>
                      </TableRow>
                      <TableRow>
                        <FieldLabel>Archived</FieldLabel>
                        <TableCell className="text-foreground">
                          {entity.archived ? "Yes" : "No"}
                        </TableCell>
                      </TableRow>
                    </TableBody>
                  </Table>
                </div>
                {Object.keys(entity.data).length > 0 && (
                  <CollapsibleData data={entity.data} />
                )}
              </TaskSection>
            )}
          </>
        )}
      </div>
    </Drawer>
  );
}
