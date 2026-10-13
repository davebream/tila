import {
  AgentEditor,
  RegisterAgentDrawer,
} from "@/components/settings/agent-editor";
import {
  ManageNote,
  SettingsHeading,
  WriteFailure,
  joinWords,
} from "@/components/settings/settings-ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { FormNotice } from "@/components/ui/form-fields";
import { QuerySection } from "@/components/ui/query-section";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  useAgentArchivePreview,
  useAgentSettings,
  useInvalidateSettings,
  useProjectRights,
  useRetryableCommand,
} from "@/hooks/use-identities";
import { useTimeTick } from "@/hooks/use-time-tick";
import {
  type AgentView,
  ApiError,
  archiveAgent,
  unarchiveAgent,
} from "@/lib/api";
import { BINDING_LABEL, deriveBindingView, leaseCountdown } from "@/lib/lease";
import {
  failureKind,
  failureMessage,
  revisionConflict,
} from "@/lib/mutation-errors";
import { deriveSectionState } from "@/lib/query-state";
import type { AgentArchiveResult, ArchiveAgent } from "@tila/schemas";
import { useId, useState } from "react";
import { Link } from "react-router";

function BindingCell({ view, now }: { view: AgentView; now: number }) {
  const observed = deriveBindingView(view.binding, now);
  if (observed.kind === "none")
    return <span className="text-muted-foreground">{BINDING_LABEL.none}</span>;
  return (
    <div>
      {BINDING_LABEL[observed.kind]} · epoch {view.binding?.binding_epoch}
      <div className="text-xs text-muted-foreground">
        lease{" "}
        {observed.kind === "attached"
          ? `expires ${leaseCountdown(observed.expiresAtMs, now)}`
          : `ended ${leaseCountdown(observed.expiresAtMs, now)}`}
        {observed.redacted && " · details hidden"}
      </div>
    </div>
  );
}

export function SettingsAgentsPage() {
  useTimeTick(5000);
  const now = Date.now();
  const { project, whoami, allowed, known } = useProjectRights();
  const manage = allowed.manageAgents;
  // Wait for the identity so a manager's first read already includes
  // archived agents and a non-manager never asks for them.
  const agents = useAgentSettings({ includeArchived: manage, enabled: known });
  const state = deriveSectionState(agents, {
    isEmpty: (data) => data.agents.length === 0,
  });
  const invalidate = useInvalidateSettings();
  const [editing, setEditing] = useState<string | null>(null);
  const [registering, setRegistering] = useState(false);
  const [archiving, setArchiving] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const unarchiveNote = useId();
  const unarchive = useRetryableCommand(
    (target: { id: string; revision: number }, key: string) =>
      unarchiveAgent(project, target.id, target.revision, key),
    {
      onSuccess: (result) => {
        setNotice(
          `Unarchived ${result.agent.id}. No binding or lease was restored; a host must attach again.`,
        );
        void invalidate.agents();
      },
      onError: (error) => {
        const kind = failureKind(error);
        if (kind === "forbidden") void invalidate.access();
        if (kind === "conflict") void invalidate.agents();
      },
    },
  );
  const rows = agents.data?.agents ?? [];
  const editingView = rows.find((row) => row.agent.id === editing);
  const archivingView = rows.find((row) => row.agent.id === archiving);
  const principal = whoami.data?.principal_id ?? null;
  const unarchiveConflict = revisionConflict(unarchive.error);

  return (
    <div className="space-y-6 p-3 md:p-6">
      <SettingsHeading
        title="Agents"
        actions={
          manage && (
            <Button
              type="button"
              onClick={() => {
                setNotice(null);
                setRegistering(true);
              }}
            >
              Register agent
            </Button>
          )
        }
      >
        Durable agent identities: their names, who may bind them and which host
        profile a new attach must use. Running sessions show here as observed
        bindings;{" "}
        <Link className="underline" to={`/p/${project}/runtime`}>
          Runtime
        </Link>{" "}
        manages them.
      </SettingsHeading>
      {known && !manage && (
        <ManageNote>
          You can view agents but not manage them. A maintainer with
          agents:manage registers, edits and archives agents.
        </ManageNote>
      )}
      {notice && <FormNotice tone="info">{notice}</FormNotice>}

      <QuerySection
        state={state}
        label="agents"
        empty="No agents registered."
        forbidden="Your access does not include agents."
        onRetry={() => void agents.refetch()}
      >
        {(data) => (
          <div className="overflow-x-auto rounded-lg border border-border">
            <Table aria-label="Agents">
              <TableHeader>
                <TableRow>
                  <TableHead>Agent</TableHead>
                  <TableHead>Owner</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead>Observed binding</TableHead>
                  <TableHead className="text-right">Revision</TableHead>
                  {manage && (
                    <TableHead>
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  )}
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.agents.map((view) => {
                  const { agent } = view;
                  const retrying = unarchive.unconfirmed?.id === agent.id;
                  return (
                    <TableRow key={agent.id} className="align-top">
                      <TableCell>
                        <div className="font-sans text-fg-strong">
                          {agent.name}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {agent.id}
                        </div>
                      </TableCell>
                      <TableCell className="text-xs">
                        {agent.owner_principal_id}
                      </TableCell>
                      <TableCell>
                        {agent.archived ? (
                          <Badge variant="gray">Archived</Badge>
                        ) : (
                          <Badge variant="green">Active</Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-xs">
                        <BindingCell view={view} now={now} />
                      </TableCell>
                      <TableCell className="tila-num text-right">
                        {agent.revision}
                      </TableCell>
                      {manage && (
                        <TableCell className="text-right">
                          {agent.archived ? (
                            <Button
                              type="button"
                              size="xs"
                              variant="outline"
                              aria-describedby={unarchiveNote}
                              aria-label={`${retrying ? "Retry unarchive" : "Unarchive"} ${agent.id}`}
                              disabled={unarchive.pending}
                              onClick={() => {
                                setNotice(null);
                                if (retrying) unarchive.retry();
                                else
                                  unarchive.send({
                                    id: agent.id,
                                    revision: agent.revision,
                                  });
                              }}
                            >
                              {retrying ? "Retry unarchive" : "Unarchive"}
                            </Button>
                          ) : (
                            <div className="flex justify-end gap-1">
                              <Button
                                type="button"
                                size="xs"
                                variant="outline"
                                aria-label={`Edit ${agent.id}`}
                                onClick={() => {
                                  setNotice(null);
                                  setEditing(agent.id);
                                }}
                              >
                                Edit
                              </Button>
                              <Button
                                type="button"
                                size="xs"
                                variant="ghost"
                                className="text-status-red"
                                aria-label={`Archive ${agent.id}`}
                                onClick={() => {
                                  setNotice(null);
                                  setArchiving(agent.id);
                                }}
                              >
                                Archive
                              </Button>
                            </div>
                          )}
                        </TableCell>
                      )}
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </QuerySection>

      {manage && rows.some((row) => row.agent.archived) && (
        <p id={unarchiveNote} className="text-xs text-muted-foreground">
          Unarchive restores the identity only: no binding, lease or expired
          delivery comes back, and a host must attach again.
        </p>
      )}
      {unarchiveConflict ? (
        <FormNotice>
          {unarchive.target?.id ?? "The agent"} changed
          {unarchiveConflict.revision === null
            ? ""
            : ` (revision ${unarchiveConflict.revision})`}{" "}
          after the list was loaded. The list is reloaded; review it and
          unarchive again.
        </FormNotice>
      ) : (
        <WriteFailure error={unarchive.error} action="unarchive" />
      )}

      {registering && (
        <RegisterAgentDrawer
          project={project}
          principal={principal}
          onClose={() => setRegistering(false)}
          onRegistered={(agent) => {
            setRegistering(false);
            setNotice(`Registered ${agent.id}. You are its owner.`);
          }}
        />
      )}
      {editingView && (
        <AgentEditor
          key={editingView.agent.id}
          project={project}
          principal={principal}
          view={editingView}
          onClose={() => setEditing(null)}
          onSaved={(agent) => {
            setEditing(null);
            setNotice(`Saved ${agent.id} as revision ${agent.revision}.`);
          }}
        />
      )}
      {archivingView && (
        <ArchiveAgentDialog
          key={archivingView.agent.id}
          project={project}
          view={archivingView}
          onClose={() => setArchiving(null)}
          onArchived={(result) => {
            setArchiving(null);
            setNotice(archivedNotice(result));
          }}
        />
      )}
    </div>
  );
}

function archivedNotice(result: AgentArchiveResult): string {
  const parts = [`Archived ${result.agent.id}.`];
  if (result.released)
    parts.push(
      `Released binding epoch ${result.released.binding_epoch}; the running session no longer acts as this agent.`,
    );
  if (result.pending_deliveries)
    parts.push(
      `Pending deliveries kept until they expire: ${result.pending_deliveries}.`,
    );
  return parts.join(" ");
}

/**
 * Archive confirmation built from the server's preview. The command names the
 * revision and the binding occupant that were reviewed; if either changed, the
 * preview is reloaded and the dialog stays open.
 */
function ArchiveAgentDialog({
  project,
  view,
  onClose,
  onArchived,
}: {
  project: string;
  view: AgentView;
  onClose: () => void;
  onArchived: (result: AgentArchiveResult) => void;
}) {
  const id = view.agent.id;
  const preview = useAgentArchivePreview(id);
  const invalidate = useInvalidateSettings();
  const [changed, setChanged] = useState<string | null>(null);
  const archive = useRetryableCommand(
    (body: ArchiveAgent, key: string) => archiveAgent(project, id, body, key),
    {
      onSuccess: (result) => {
        void invalidate.agents();
        onArchived(result);
      },
      onError: (error) => {
        if (failureKind(error) === "forbidden") void invalidate.access();
        const conflict = revisionConflict(error);
        if (error instanceof ApiError && error.code === "stale-binding") {
          setChanged(
            "The binding changed while you reviewed it: another session attached or the occupant was released. The effects above are reloaded; review them and confirm again.",
          );
        } else if (conflict) {
          setChanged(
            `The agent changed${conflict.revision === null ? "" : ` (revision ${conflict.revision})`} while you reviewed it. The effects above are reloaded; review them and confirm again.`,
          );
        } else return;
        // Re-reads the list and this preview (same key prefix).
        void invalidate.agents();
      },
    },
  );
  const p = preview.data;
  const listed = view.binding;
  const host =
    p?.binding &&
    listed &&
    "host_ref" in listed &&
    listed.binding_epoch === p.binding.binding_epoch
      ? listed.host_ref
      : null;
  const handled =
    revisionConflict(archive.error) !== null ||
    (archive.error instanceof ApiError &&
      archive.error.code === "stale-binding");
  const kind = archive.error ? failureKind(archive.error) : null;
  const error =
    !archive.error || handled
      ? (changed ?? null)
      : kind === "unconfirmed"
        ? `The server did not confirm the archive (${failureMessage(archive.error)}). Retry sends the same request.`
        : kind === "forbidden"
          ? "Your access changed; nothing was archived."
          : failureMessage(archive.error);

  return (
    <ConfirmAction
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={`Archive agent ${id}`}
      confirmText={id}
      confirmLabel={archive.unconfirmed ? "Retry archive" : "Archive agent"}
      pending={archive.pending}
      disabled={!p || p.archived || preview.isFetching}
      error={error}
      onConfirm={() => {
        if (archive.unconfirmed) return archive.retry();
        if (!p) return;
        setChanged(null);
        archive.send({
          expected_revision: p.revision,
          ...(p.binding ? { expected_epoch: p.binding.binding_epoch } : {}),
        });
      }}
      description={
        <div className="space-y-2">
          <p>
            The ID, its history and attribution are kept. New bindings and
            deliveries stop.
          </p>
          {preview.isPending ? (
            <p>Checking what archiving affects…</p>
          ) : !p ? (
            <p role="alert" className="text-status-red">
              Could not check what archiving affects.{" "}
              <button
                type="button"
                className="underline"
                onClick={() => void preview.refetch()}
              >
                Retry
              </button>
            </p>
          ) : p.archived ? (
            <p>This agent is already archived.</p>
          ) : (
            <ul
              aria-label="Archive effects"
              className="list-disc space-y-1 pl-5"
            >
              <li>
                {p.binding
                  ? `Releases the active binding (epoch ${p.binding.binding_epoch}${host ? ` on host ${host}` : ""}) and advances the epoch, so the running session loses agent authority now.`
                  : "No active binding to release."}
              </li>
              <li>
                {p.pending_deliveries
                  ? `Pending deliveries: ${p.pending_deliveries}. They stay until they expire; none is deleted.`
                  : "No pending deliveries."}
              </li>
              <li>
                {p.rooms.length
                  ? `Stays listed in ${p.rooms.length === 1 ? "room" : "rooms"} ${joinWords(p.rooms)} but receives no new messages.`
                  : "Not a member of any room."}
              </li>
              <li>
                {p.open_questions
                  ? `Open questions it asked: ${p.open_questions}. They are superseded.`
                  : "No open questions to supersede."}
              </li>
              <li>
                {p.unfinished_attempts ? (
                  <>
                    Unfinished attempts: {p.unfinished_attempts}. Archiving does
                    not stop them; cancel or reassign them in{" "}
                    <Link
                      className="underline"
                      to={`/p/${project}/queue`}
                      onClick={onClose}
                    >
                      Queue
                    </Link>
                    .
                  </>
                ) : (
                  "No unfinished attempts."
                )}
              </li>
            </ul>
          )}
        </div>
      }
    />
  );
}
