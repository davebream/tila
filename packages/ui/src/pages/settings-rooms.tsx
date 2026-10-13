import {
  CreateRoomDrawer,
  HISTORY_LABEL,
  RoomEditor,
  formatTtl,
} from "@/components/settings/room-editor";
import {
  ManageNote,
  SettingsHeading,
  WriteFailure,
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
  useInvalidateSettings,
  useProjectRights,
  useRetryableCommand,
  useRoomArchivePreview,
  useRoomSettings,
} from "@/hooks/use-identities";
import { ApiError, setRoomArchived } from "@/lib/api";
import {
  failureKind,
  failureMessage,
  revisionConflict,
} from "@/lib/mutation-errors";
import { deriveSectionState } from "@/lib/query-state";
import { ConversationsNotConfigured } from "@/pages/rooms";
import type { Room } from "@tila/schemas";
import { useId, useState } from "react";
import { Link } from "react-router";

export function SettingsRoomsPage() {
  const { project, whoami, allowed, known } = useProjectRights();
  const manage = allowed.manageRooms;
  const rooms = useRoomSettings();
  // The deployment lacks the conversation signing secret: no room can be
  // read or managed until an operator sets it.
  const conversationsOff =
    rooms.error instanceof ApiError &&
    rooms.error.code === "config-unavailable";
  const state = deriveSectionState(rooms, {
    isEmpty: (data) => data.rooms.length === 0,
  });
  const invalidate = useInvalidateSettings();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [archiving, setArchiving] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const unarchiveNote = useId();
  const unarchive = useRetryableCommand(
    (target: { id: string; revision: number }, key: string) =>
      setRoomArchived(project, target.id, false, target.revision, key),
    {
      onSuccess: (result) => {
        setNotice(
          `Unarchived ${result.room.id}. Publication and wakes resume; deliveries that expired meanwhile do not come back.`,
        );
        void invalidate.rooms();
      },
      onError: (error) => {
        const kind = failureKind(error);
        if (kind === "forbidden") void invalidate.access();
        if (kind === "conflict") void invalidate.rooms();
      },
    },
  );
  const list = rooms.data?.rooms ?? [];
  const editingRoom = list.find((room) => room.id === editing);
  const archivingRoom = list.find((room) => room.id === archiving);
  const principal = whoami.data?.principal_id ?? null;
  const unarchiveConflict = revisionConflict(unarchive.error);
  const controls = manage && !conversationsOff;

  return (
    <div className="space-y-6 p-3 md:p-6">
      <SettingsHeading
        title="Rooms"
        actions={
          controls && (
            <Button
              type="button"
              onClick={() => {
                setNotice(null);
                setCreating(true);
              }}
            >
              Create room
            </Button>
          )
        }
      >
        Shared conversation rooms: who belongs, who can read the history, how
        long deliveries wait and how many wakes a conversation may cause. Read
        the conversations in{" "}
        <Link className="underline" to={`/p/${project}/rooms`}>
          Conversations › Rooms
        </Link>
        .
      </SettingsHeading>
      {known && !manage && (
        <ManageNote>
          You can view rooms but not manage them. A maintainer with
          conversations:manage creates rooms and changes their settings and
          members.
        </ManageNote>
      )}
      {notice && <FormNotice tone="info">{notice}</FormNotice>}

      {conversationsOff ? (
        <ConversationsNotConfigured error={rooms.error} />
      ) : (
        <QuerySection
          state={state}
          label="rooms"
          empty="No rooms you can read."
          forbidden="Your access does not include rooms."
          onRetry={() => void rooms.refetch()}
        >
          {(data) => (
            <div className="overflow-x-auto rounded-lg border border-border">
              <Table aria-label="Rooms">
                <TableHeader>
                  <TableRow>
                    <TableHead>Room</TableHead>
                    <TableHead>History</TableHead>
                    <TableHead>Delivery TTL</TableHead>
                    <TableHead>Budgets</TableHead>
                    <TableHead>State</TableHead>
                    <TableHead className="text-right">Revision</TableHead>
                    {manage && (
                      <TableHead>
                        <span className="sr-only">Actions</span>
                      </TableHead>
                    )}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.rooms.map((room) => {
                    const retrying = unarchive.unconfirmed?.id === room.id;
                    return (
                      <TableRow key={room.id} className="align-top">
                        <TableCell>
                          <Link
                            className="font-sans text-fg-strong underline-offset-2 hover:underline"
                            to={`/p/${project}/rooms/${encodeURIComponent(room.id)}`}
                          >
                            {room.name}
                          </Link>
                          <div className="text-xs text-muted-foreground">
                            {room.id}
                          </div>
                        </TableCell>
                        <TableCell className="font-sans text-xs">
                          {HISTORY_LABEL[room.history_policy]}
                        </TableCell>
                        <TableCell>
                          {formatTtl(room.delivery_ttl_seconds)}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          hops {room.budgets.max_hops} · pair{" "}
                          {room.budgets.pair_exchanges} · agent wakes{" "}
                          {room.budgets.agent_wakes} · room wakes{" "}
                          {room.budgets.room_wakes}
                        </TableCell>
                        <TableCell>
                          {room.archived ? (
                            <Badge variant="gray">Archived</Badge>
                          ) : (
                            <Badge variant="green">Active</Badge>
                          )}
                        </TableCell>
                        <TableCell className="tila-num text-right">
                          {room.revision}
                        </TableCell>
                        {manage && (
                          <TableCell className="text-right">
                            <div className="flex justify-end gap-1">
                              <Button
                                type="button"
                                size="xs"
                                variant="outline"
                                aria-label={`Edit ${room.id}`}
                                onClick={() => {
                                  setNotice(null);
                                  setEditing(room.id);
                                }}
                              >
                                Edit
                              </Button>
                              {room.archived ? (
                                <Button
                                  type="button"
                                  size="xs"
                                  variant="outline"
                                  aria-describedby={unarchiveNote}
                                  aria-label={`${retrying ? "Retry unarchive" : "Unarchive"} ${room.id}`}
                                  disabled={unarchive.pending}
                                  onClick={() => {
                                    setNotice(null);
                                    if (retrying) unarchive.retry();
                                    else
                                      unarchive.send({
                                        id: room.id,
                                        revision: room.revision,
                                      });
                                  }}
                                >
                                  {retrying ? "Retry unarchive" : "Unarchive"}
                                </Button>
                              ) : (
                                <Button
                                  type="button"
                                  size="xs"
                                  variant="ghost"
                                  className="text-status-red"
                                  aria-label={`Archive ${room.id}`}
                                  onClick={() => {
                                    setNotice(null);
                                    setArchiving(room.id);
                                  }}
                                >
                                  Archive
                                </Button>
                              )}
                            </div>
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
      )}

      {manage && list.some((room) => room.archived) && (
        <p id={unarchiveNote} className="text-xs text-muted-foreground">
          Unarchive reopens publication and wakes. Deliveries that expired while
          the room was archived do not come back.
        </p>
      )}
      {unarchiveConflict ? (
        <FormNotice>
          {unarchive.target?.id ?? "The room"} changed
          {unarchiveConflict.revision === null
            ? ""
            : ` (revision ${unarchiveConflict.revision})`}{" "}
          after the list was loaded. The list is reloaded; review it and
          unarchive again.
        </FormNotice>
      ) : (
        <WriteFailure error={unarchive.error} action="unarchive" />
      )}

      {creating && (
        <CreateRoomDrawer
          project={project}
          principal={principal}
          onClose={() => setCreating(false)}
          onCreated={(room) => {
            setCreating(false);
            setNotice(`Created ${room.id}. Edit it to add members.`);
          }}
        />
      )}
      {editingRoom && (
        <RoomEditor
          key={editingRoom.id}
          project={project}
          principal={principal}
          room={editingRoom}
          onClose={() => setEditing(null)}
          onSaved={(room) => {
            setEditing(null);
            setNotice(`Saved ${room.id} as revision ${room.revision}.`);
          }}
        />
      )}
      {archivingRoom && (
        <ArchiveRoomDialog
          key={archivingRoom.id}
          project={project}
          room={archivingRoom}
          onClose={() => setArchiving(null)}
          onArchived={(room) => {
            setArchiving(null);
            setNotice(
              `Archived ${room.id}. Its history stays readable; pending deliveries can still be acknowledged until they expire.`,
            );
          }}
        />
      )}
    </div>
  );
}

/** Archive confirmation built from the server's preview of the room. */
function ArchiveRoomDialog({
  project,
  room,
  onClose,
  onArchived,
}: {
  project: string;
  room: Room;
  onClose: () => void;
  onArchived: (room: Room) => void;
}) {
  const preview = useRoomArchivePreview(room.id);
  const invalidate = useInvalidateSettings();
  const [changed, setChanged] = useState<string | null>(null);
  const archive = useRetryableCommand(
    (revision: number, key: string) =>
      setRoomArchived(project, room.id, true, revision, key),
    {
      onSuccess: (result) => {
        void invalidate.rooms();
        onArchived(result.room);
      },
      onError: (error) => {
        if (failureKind(error) === "forbidden") void invalidate.access();
        const conflict = revisionConflict(error);
        if (!conflict) return;
        setChanged(
          `The room changed${conflict.revision === null ? "" : ` (revision ${conflict.revision})`} while you reviewed it. The counts above are reloaded; review them and confirm again.`,
        );
        // Re-reads the list and this preview (same key prefix).
        void invalidate.rooms();
      },
    },
  );
  const p = preview.data;
  const kind = archive.error ? failureKind(archive.error) : null;
  const error =
    !archive.error || revisionConflict(archive.error)
      ? changed
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
      title={`Archive room ${room.id}`}
      confirmText={room.id}
      confirmLabel={
        archive.unconfirmed !== null ? "Retry archive" : "Archive room"
      }
      pending={archive.pending}
      disabled={!p || p.archived || preview.isFetching}
      error={error}
      onConfirm={() => {
        if (archive.unconfirmed !== null) return archive.retry();
        if (!p) return;
        setChanged(null);
        archive.send(p.revision);
      }}
      description={
        <div className="space-y-2">
          <p>
            Publication and new threads stop now; wakes stop at the next
            dispatch. The room and its settings are kept.
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
            <p>This room is already archived.</p>
          ) : (
            <ul
              aria-label="Archive effects"
              className="list-disc space-y-1 pl-5"
            >
              <li>
                Messages: {p.messages}. The history stays readable under the
                room's history policy.
              </li>
              <li>Members: {p.members}. Membership is kept.</li>
              <li>
                {p.pending_deliveries
                  ? `Pending deliveries: ${p.pending_deliveries}. Recipients can still fetch and acknowledge them until they expire.`
                  : "No pending deliveries."}
              </li>
            </ul>
          )}
        </div>
      }
    />
  );
}
