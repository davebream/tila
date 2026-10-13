import { ManageNote, SettingsHeading } from "@/components/settings/settings-ui";
import {
  CreateSignalGroupDrawer,
  SignalGroupEditor,
} from "@/components/settings/signal-group-editor";
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
import { useSignalGroups } from "@/hooks/use-api";
import {
  useInvalidateSettings,
  useProjectRights,
  useRetryableCommand,
} from "@/hooks/use-identities";
import { ApiError, deleteSignalGroup } from "@/lib/api";
import {
  failureKind,
  failureMessage,
  revisionConflict,
} from "@/lib/mutation-errors";
import { deriveSectionState } from "@/lib/query-state";
import { relativeTime } from "@/lib/time";
import type { SignalGroup } from "@tila/schemas";
import { useState } from "react";
import { Link } from "react-router";

export function SettingsSignalGroupsPage() {
  const { project, whoami, allowed, known } = useProjectRights();
  const manage = allowed.manageSignalGroups;
  const groups = useSignalGroups();
  const state = deriveSectionState(groups, {
    isEmpty: (data) => data.groups.length === 0,
  });
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const list = groups.data?.groups ?? [];
  const editingGroup = list.find((group) => group.id === editing);
  const deletingGroup = list.find((group) => group.id === deleting);
  const principal = whoami.data?.principal_id ?? null;

  return (
    <div className="space-y-6 p-3 md:p-6">
      <SettingsHeading
        title="Signal groups"
        actions={
          manage && (
            <Button
              type="button"
              onClick={() => {
                setNotice(null);
                setCreating(true);
              }}
            >
              Create group
            </Button>
          )
        }
      >
        Named sets of principals that a signal can target. A change affects
        later sends only: signals already sent keep their recipients and
        acknowledgements. Sent signals are listed in{" "}
        <Link className="underline" to={`/p/${project}/signals`}>
          Conversations › Signals
        </Link>
        .
      </SettingsHeading>
      {known && !manage && (
        <ManageNote>
          You can view signal groups but not manage them. A maintainer with
          signals:manage creates, edits and deletes groups.
        </ManageNote>
      )}
      {notice && <FormNotice tone="info">{notice}</FormNotice>}

      <QuerySection
        state={state}
        label="signal groups"
        empty="No signal groups."
        forbidden="Your access does not include signal groups."
        onRetry={() => void groups.refetch()}
      >
        {(data) => (
          <div className="overflow-x-auto rounded-lg border border-border">
            <Table aria-label="Signal groups">
              <TableHeader>
                <TableRow>
                  <TableHead>Group</TableHead>
                  <TableHead className="text-right">Members</TableHead>
                  <TableHead className="text-right">Revision</TableHead>
                  <TableHead className="text-right">Updated</TableHead>
                  {manage && (
                    <TableHead>
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  )}
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.groups.map((group) => (
                  <TableRow key={group.id}>
                    <TableCell>
                      <div className="font-sans text-fg-strong">
                        {group.name}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {group.id}
                      </div>
                    </TableCell>
                    <TableCell className="tila-num text-right">
                      {group.principal_ids.length}
                    </TableCell>
                    <TableCell className="tila-num text-right">
                      {group.revision}
                    </TableCell>
                    <TableCell className="tila-num text-right text-muted-foreground">
                      {relativeTime(group.updated_at)}
                    </TableCell>
                    {manage && (
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          <Button
                            type="button"
                            size="xs"
                            variant="outline"
                            aria-label={`Edit ${group.id}`}
                            onClick={() => {
                              setNotice(null);
                              setEditing(group.id);
                            }}
                          >
                            Edit
                          </Button>
                          <Button
                            type="button"
                            size="xs"
                            variant="ghost"
                            className="text-status-red"
                            aria-label={`Delete ${group.id}`}
                            onClick={() => {
                              setNotice(null);
                              setDeleting(group.id);
                            }}
                          >
                            Delete
                          </Button>
                        </div>
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </QuerySection>

      {creating && (
        <CreateSignalGroupDrawer
          project={project}
          principal={principal}
          onClose={() => setCreating(false)}
          onCreated={(group) => {
            setCreating(false);
            setNotice(`Created ${group.id}.`);
          }}
        />
      )}
      {editingGroup && (
        <SignalGroupEditor
          key={editingGroup.id}
          project={project}
          principal={principal}
          group={editingGroup}
          onClose={() => setEditing(null)}
          onSaved={(group) => {
            setEditing(null);
            setNotice(`Saved ${group.id} as revision ${group.revision}.`);
          }}
        />
      )}
      {deletingGroup && (
        <DeleteGroupDialog
          key={deletingGroup.id}
          project={project}
          group={deletingGroup}
          onClose={() => setDeleting(null)}
          onDeleted={(message) => {
            setDeleting(null);
            setNotice(message);
          }}
        />
      )}
    </div>
  );
}

/**
 * Delete against the revision on screen. A change in between keeps the dialog
 * open on the re-read group; a group that is already gone counts as deleted.
 */
function DeleteGroupDialog({
  project,
  group,
  onClose,
  onDeleted,
}: {
  project: string;
  group: SignalGroup;
  onClose: () => void;
  onDeleted: (message: string) => void;
}) {
  const invalidate = useInvalidateSettings();
  const [changed, setChanged] = useState<string | null>(null);
  const remove = useRetryableCommand(
    (revision: number, key: string) =>
      deleteSignalGroup(project, group.id, revision, key),
    {
      onSuccess: () => {
        void invalidate.groups();
        onDeleted(
          `Deleted ${group.id}. Signals already sent to it keep their recipients.`,
        );
      },
      onError: (error) => {
        if (failureKind(error) === "forbidden") void invalidate.access();
        if (
          error instanceof ApiError &&
          error.code === "signal-group-not-found"
        ) {
          void invalidate.groups();
          onDeleted(`${group.id} was already deleted.`);
          return;
        }
        const conflict = revisionConflict(error);
        if (!conflict) return;
        setChanged(
          `The group changed${conflict.revision === null ? "" : ` (revision ${conflict.revision})`} after you opened this. Its current members are shown above; review them and confirm again.`,
        );
        void invalidate.groups();
      },
    },
  );
  const kind = remove.error ? failureKind(remove.error) : null;
  const error =
    !remove.error || revisionConflict(remove.error)
      ? changed
      : kind === "unconfirmed"
        ? `The server did not confirm the deletion (${failureMessage(remove.error)}). Retry sends the same request.`
        : kind === "forbidden"
          ? "Your access changed; nothing was deleted."
          : failureMessage(remove.error);

  return (
    <ConfirmAction
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={`Delete signal group ${group.id}`}
      confirmText={group.id}
      confirmLabel={
        remove.unconfirmed !== null ? "Retry delete" : "Delete group"
      }
      pending={remove.pending}
      error={error}
      onConfirm={() => {
        if (remove.unconfirmed !== null) return remove.retry();
        setChanged(null);
        remove.send(group.revision);
      }}
      description={
        <div className="space-y-2">
          <p>
            Signals can no longer target this group. Signals already sent to it
            are not changed or cancelled: their recipients and acknowledgements
            stay until they expire.
          </p>
          <p>
            Revision {group.revision} · {group.principal_ids.length}{" "}
            {group.principal_ids.length === 1 ? "member" : "members"}
          </p>
        </div>
      }
    />
  );
}
