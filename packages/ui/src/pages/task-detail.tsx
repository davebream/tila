import { Badge } from "@/components/ui/badge";
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
import { useClaims, useTask, useTaskArtifactRefs } from "@/hooks/use-api";
import { useAuth } from "@/hooks/use-auth";
import { useTimeTick } from "@/hooks/use-time-tick";
import { type SectionState, deriveSectionState } from "@/lib/query-state";
import { formatDateTime, relativeTime } from "@/lib/time";
import type { StateListResponse } from "@tila/schemas";
import { ChevronRight, Maximize2, Minimize2 } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";

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

export function TaskDetailPage() {
  useTimeTick();
  const { id } = useParams<{ id: string }>();
  const { projectId } = useAuth();
  const navigate = useNavigate();
  const entityId = id ?? "";

  const taskQuery = useTask(entityId);
  const claimsQuery = useClaims();
  const refsQuery = useTaskArtifactRefs(entityId);

  const [expanded, setExpanded] = useState(false);

  // Fields and Relationships both come from the task query, so a task failure
  // must reach both. Each section is otherwise derived from its own request.
  const fieldsState = deriveSectionState(taskQuery);
  const relationshipsState = deriveSectionState(taskQuery, {
    isEmpty: (d) => (d.relationships ?? []).length === 0,
  });
  const refsState = deriveSectionState(refsQuery, {
    isEmpty: (d) => d.references.length === 0,
  });

  const entity = fieldsState.phase === "ready" ? fieldsState.data.entity : null;
  const findClaim = (d: StateListResponse): Claim | undefined =>
    d.claims.find((c) =>
      claimResourceMatchesEntity(c.resource, entityId, entity?.type),
    );
  const claimsState = deriveSectionState(claimsQuery, {
    isEmpty: (d) => findClaim(d) === undefined,
  });
  // The typed "<type>:<id>" claim form can only be matched once the task type is
  // known, so "no match" is not trustworthy until the task query has resolved.
  const claimState: SectionState<StateListResponse> =
    fieldsState.phase === "pending"
      ? { phase: "pending", paused: fieldsState.paused }
      : fieldsState.phase === "failed"
        ? { phase: "failed", kind: fieldsState.kind, error: fieldsState.error }
        : claimsState;

  // When the task itself is gone or off limits, claims/artifacts/relationships
  // describe a subject the viewer cannot see, so they are not shown at all.
  const subjectUnavailable =
    fieldsState.phase === "failed" &&
    (fieldsState.kind === "forbidden" ||
      fieldsState.kind === "not-found" ||
      fieldsState.kind === "unauthenticated");

  const retryTask = () => void taskQuery.refetch();
  const retryClaims = () => {
    if (fieldsState.phase !== "ready") void taskQuery.refetch();
    void claimsQuery.refetch();
  };
  const retryRefs = () => void refsQuery.refetch();

  return (
    <Drawer
      onClose={() => navigate(`/p/${projectId}/tasks`)}
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
      title={
        <span className="flex items-center gap-1.5">
          <Link
            to={`/p/${projectId}/tasks`}
            className="text-muted-foreground hover:text-foreground"
          >
            Tasks
          </Link>
          <span className="text-muted-foreground">/</span>
          <span>{entityId}</span>
          <CopyButton value={entityId} />
          {entity && (
            <Badge variant="secondary" className="ml-1">
              {entity.type}
            </Badge>
          )}
        </span>
      }
    >
      <div className="space-y-8 p-6">
        <TaskSection title="Fields">
          <QuerySection
            state={fieldsState}
            label="task data"
            empty="Task not found."
            notFound="Task not found."
            onRetry={retryTask}
          >
            {({ entity: fields }) => (
              <>
                <div className="border-t border-border">
                  <Table aria-label="Task fields">
                    <TableBody>
                      <TableRow>
                        <FieldLabel>Type</FieldLabel>
                        <TableCell className="text-foreground">
                          {fields.type}
                        </TableCell>
                      </TableRow>
                      <TableRow>
                        <FieldLabel>
                          <InfoTip content="Data schema revision applied to this task">
                            Schema Version
                          </InfoTip>
                        </FieldLabel>
                        <TableCell className="tila-num text-foreground">
                          {fields.schema_version}
                        </TableCell>
                      </TableRow>
                      <TableRow>
                        <FieldLabel>Created By</FieldLabel>
                        <TableCell className="text-foreground">
                          {fields.created_by}
                        </TableCell>
                      </TableRow>
                      <TableRow>
                        <FieldLabel>Created At</FieldLabel>
                        <TableCell className="tila-num text-muted-foreground">
                          {formatDateTime(fields.created_at)}
                        </TableCell>
                      </TableRow>
                      <TableRow>
                        <FieldLabel>Updated At</FieldLabel>
                        <TableCell className="tila-num text-muted-foreground">
                          {formatDateTime(fields.updated_at)}
                        </TableCell>
                      </TableRow>
                      <TableRow>
                        <FieldLabel>Archived</FieldLabel>
                        <TableCell className="text-foreground">
                          {fields.archived ? "Yes" : "No"}
                        </TableCell>
                      </TableRow>
                    </TableBody>
                  </Table>
                </div>
                {fields.data && Object.keys(fields.data).length > 0 && (
                  <CollapsibleData data={fields.data} />
                )}
              </>
            )}
          </QuerySection>
        </TaskSection>

        {!subjectUnavailable && (
          <>
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

            <TaskSection title="Artifacts">
              <QuerySection
                state={refsState}
                label="artifacts"
                empty="No artifacts attached."
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

            <TaskSection title="Relationships">
              <QuerySection
                state={relationshipsState}
                label="relationships"
                empty="No relationships."
                onRetry={retryTask}
              >
                {({ relationships }) => (
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
                        {relationships.map((rel) => (
                          <TableRow
                            key={`${rel.type}-${rel.from_id}-${rel.to_id}`}
                          >
                            <TableCell>
                              <Badge variant="secondary">{rel.type}</Badge>
                            </TableCell>
                            <TableCell>
                              <Link
                                to={`/p/${projectId}/tasks/${rel.from_id}`}
                                className={dataLinkClass}
                              >
                                {rel.from_id}
                              </Link>
                            </TableCell>
                            <TableCell>
                              <Link
                                to={`/p/${projectId}/tasks/${rel.to_id}`}
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
                )}
              </QuerySection>
            </TaskSection>
          </>
        )}
      </div>
    </Drawer>
  );
}
