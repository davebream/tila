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
import { useClaims, useTask, useTaskArtifactRefs } from "@/hooks/use-api";
import { useAuth } from "@/hooks/use-auth";
import { useTimeTick } from "@/hooks/use-time-tick";
import { formatDateTime, relativeTime } from "@/lib/time";
import { ChevronRight, Maximize2, Minimize2 } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";

const dataLinkClass =
  "rounded-sm text-signal-blue underline decoration-signal-blue/40 underline-offset-2 hover:text-signal-blue-hover hover:decoration-signal-blue focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal-blue";

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <h2 className="tila-label">{children}</h2>;
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return <p className="py-3 text-sm text-muted-foreground">{children}</p>;
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

  const {
    data: entityData,
    isLoading: entityLoading,
    isError: entityError,
    error: entityFetchError,
    refetch: refetchEntity,
  } = useTask(entityId);
  const { data: claimsData } = useClaims();
  const { data: artifactData } = useTaskArtifactRefs(entityId);

  const [expanded, setExpanded] = useState(false);
  const entity = entityData?.entity;
  const relationships = entityData?.relationships ?? [];
  const entityClaim = claimsData?.claims.find((c) =>
    claimResourceMatchesEntity(c.resource, entityId, entity?.type),
  );
  const references = artifactData?.references ?? [];

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
        <section className="space-y-3">
          <SectionLabel>Fields</SectionLabel>
          {entityError ? (
            <TableError
              error={entityFetchError}
              onRetry={() => refetchEntity()}
            />
          ) : entityLoading ? (
            <EmptyState>Loading task data...</EmptyState>
          ) : entity ? (
            <>
              <div className="border-t border-border">
                <Table aria-label="Task fields">
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
              {entity.data && Object.keys(entity.data).length > 0 && (
                <CollapsibleData data={entity.data} />
              )}
            </>
          ) : (
            <EmptyState>Task not found.</EmptyState>
          )}
        </section>

        <section className="space-y-3">
          <SectionLabel>Claim State</SectionLabel>
          {entityClaim ? (
            <div className="overflow-hidden rounded-lg border border-border">
              <Table aria-label="Claim state">
                <TableBody>
                  <TableRow>
                    <FieldLabel>
                      <InfoTip content="Unique identifier of the machine holding this claim">
                        Machine
                      </InfoTip>
                    </FieldLabel>
                    <TableCell className="text-foreground">
                      {entityClaim.machine}
                    </TableCell>
                  </TableRow>
                  <TableRow>
                    <FieldLabel>User</FieldLabel>
                    <TableCell className="text-foreground">
                      {entityClaim.user}
                    </TableCell>
                  </TableRow>
                  <TableRow>
                    <FieldLabel>
                      <InfoTip content="Lock mode: exclusive (one writer) or shared (multiple readers)">
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
          ) : (
            <EmptyState>Not claimed.</EmptyState>
          )}
        </section>

        <section className="space-y-3">
          <SectionLabel>Artifacts</SectionLabel>
          {references.length === 0 ? (
            <EmptyState>No artifacts attached.</EmptyState>
          ) : (
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
        </section>

        <section className="space-y-3">
          <SectionLabel>Relationships</SectionLabel>
          {relationships.length === 0 ? (
            <EmptyState>No relationships.</EmptyState>
          ) : (
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
                    <TableRow key={`${rel.type}-${rel.from_id}-${rel.to_id}`}>
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
        </section>
      </div>
    </Drawer>
  );
}
