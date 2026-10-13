import {
  CheckboxField,
  EditorSection,
} from "@/components/definitions/controls";
import {
  Facts,
  LandedNotice,
  WriteFailure,
} from "@/components/settings/settings-ui";
import { Button } from "@/components/ui/button";
import { Drawer } from "@/components/ui/drawer";
import {
  FormNotice,
  SelectField,
  TextField,
} from "@/components/ui/form-fields";
import {
  useInvalidateSettings,
  useRetryableCommand,
  useRoomDetail,
} from "@/hooks/use-identities";
import {
  ApiError,
  type RoomCreate,
  createRoom,
  removeRoomMember,
  setRoomMember,
  updateRoom,
} from "@/lib/api";
import { failureKind, revisionConflict } from "@/lib/mutation-errors";
import {
  editOperation,
  operationKey,
  releaseOperation,
  stageOperation,
  useOperationDraft,
} from "@/lib/operation-draft";
import { type SettingsCopy, useSettingsDraft } from "@/lib/settings-draft";
import { formatDateTime } from "@/lib/time";
import { useMutation } from "@tanstack/react-query";
import {
  AgentIdSchema,
  type Room,
  type UpdateRoom,
  UpdateRoomSchema,
} from "@tila/schemas";
import { type FormEvent, useState } from "react";
import { z } from "zod";

const RoomForm = z.object({
  name: z.string(),
  history_policy: z.enum(["members", "project"]),
  ttl: z.string(),
  max_hops: z.string(),
  pair_exchanges: z.string(),
  agent_wakes: z.string(),
  room_wakes: z.string(),
});
type RoomForm = z.infer<typeof RoomForm>;
type BudgetField = "max_hops" | "pair_exchanges" | "agent_wakes" | "room_wakes";

const BUDGETS: Array<{
  field: BudgetField;
  label: string;
  min: number;
  max: number;
}> = [
  { field: "max_hops", label: "Hops per chain", min: 0, max: 8 },
  { field: "pair_exchanges", label: "Exchanges per pair", min: 1, max: 10 },
  { field: "agent_wakes", label: "Wakes per agent", min: 1, max: 20 },
  { field: "room_wakes", label: "Wakes per room", min: 1, max: 60 },
];
const TTL = { min: 60, max: 604_800 };

export const ROOM_FIELD_LABELS: Record<keyof RoomForm, string> = {
  name: "the name",
  history_policy: "the history visibility",
  ttl: "the delivery TTL",
  max_hops: "the hop budget",
  pair_exchanges: "the pair exchange budget",
  agent_wakes: "the agent wake budget",
  room_wakes: "the room wake budget",
};

export const HISTORY_LABEL: Record<Room["history_policy"], string> = {
  members: "Members only",
  project: "Every project reader",
};

const DEFAULT_FORM: RoomForm = {
  name: "",
  history_policy: "members",
  ttl: String(TTL.max),
  max_hops: "8",
  pair_exchanges: "10",
  agent_wakes: "20",
  room_wakes: "60",
};

/** "7d", "90m", "45s": the largest whole unit. */
export function formatTtl(seconds: number): string {
  if (seconds % 86_400 === 0) return `${seconds / 86_400}d`;
  if (seconds % 3_600 === 0) return `${seconds / 3_600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

function toForm(room: Room): RoomForm {
  return {
    name: room.name,
    history_policy: room.history_policy,
    ttl: String(room.delivery_ttl_seconds),
    max_hops: String(room.budgets.max_hops),
    pair_exchanges: String(room.budgets.pair_exchanges),
    agent_wakes: String(room.budgets.agent_wakes),
    room_wakes: String(room.budgets.room_wakes),
  };
}

const whole = (text: string) =>
  /^\d+$/.test(text.trim()) ? Number(text.trim()) : null;

function canonical(form: RoomForm) {
  const value = (text: string) => whole(text) ?? text.trim();
  return {
    name: form.name.trim(),
    history_policy: form.history_policy,
    ttl: value(form.ttl),
    max_hops: value(form.max_hops),
    pair_exchanges: value(form.pair_exchanges),
    agent_wakes: value(form.agent_wakes),
    room_wakes: value(form.room_wakes),
  };
}

type Problems = Partial<Record<keyof RoomForm | "id", string>>;

function roomProblems(form: RoomForm): Problems {
  const found: Problems = {};
  const name = form.name.trim();
  if (!name) found.name = "Enter a name.";
  else if (name.length > 200) found.name = "Use at most 200 characters.";
  const ttl = whole(form.ttl);
  if (ttl === null || ttl < TTL.min || ttl > TTL.max)
    found.ttl = `Enter whole seconds from ${TTL.min} to ${TTL.max}.`;
  for (const { field, min, max } of BUDGETS) {
    const n = whole(form[field]);
    if (n === null || n < min || n > max)
      found[field] = `Enter a whole number from ${min} to ${max}.`;
  }
  return found;
}

function budgets(form: RoomForm): Room["budgets"] {
  return {
    max_hops: Number(form.max_hops),
    pair_exchanges: Number(form.pair_exchanges),
    agent_wakes: Number(form.agent_wakes),
    room_wakes: Number(form.room_wakes),
  };
}

const json = (value: unknown) => JSON.stringify(value);

function buildUpdate(copy: SettingsCopy<RoomForm>): UpdateRoom {
  const next = canonical(copy.form);
  const base = canonical(copy.base);
  const body: UpdateRoom = { expected_revision: copy.revision };
  if (next.name !== base.name) body.name = next.name;
  if (next.history_policy !== base.history_policy)
    body.history_policy = next.history_policy;
  if (next.ttl !== base.ttl) body.delivery_ttl_seconds = Number(next.ttl);
  if (BUDGETS.some(({ field }) => json(next[field]) !== json(base[field])))
    body.budgets = budgets(copy.form);
  return body;
}

/** Name, history visibility, delivery TTL and budgets, with effect timing. */
function RoomSettingsFields({
  form,
  problems,
  disabled,
  onChange,
}: {
  form: RoomForm;
  problems: Problems;
  disabled: boolean;
  onChange: (change: Partial<RoomForm>) => void;
}) {
  return (
    <>
      <TextField
        label="Name"
        required
        value={form.name}
        disabled={disabled}
        error={problems.name}
        onChange={(e) => onChange({ name: e.target.value })}
      />
      <SelectField
        label="Who can read the history"
        value={form.history_policy}
        disabled={disabled}
        options={[
          { value: "members", label: HISTORY_LABEL.members },
          { value: "project", label: HISTORY_LABEL.project },
        ]}
        hint="Takes effect immediately, for past messages too."
        onChange={(e) =>
          onChange({
            history_policy: e.target.value as RoomForm["history_policy"],
          })
        }
      />
      <TextField
        label="Delivery TTL (seconds)"
        required
        type="number"
        min={TTL.min}
        max={TTL.max}
        className="font-mono"
        value={form.ttl}
        disabled={disabled}
        error={problems.ttl}
        hint={`${TTL.min} to ${TTL.max} (7 days). Applies to messages published after the change; existing deliveries keep their expiry.`}
        onChange={(e) => onChange({ ttl: e.target.value })}
      />
      <fieldset className="space-y-3">
        <legend className="text-sm font-medium">Conversation budgets</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          {BUDGETS.map(({ field, label, min, max }) => (
            <TextField
              key={field}
              label={`${label} (${min}–${max})`}
              required
              type="number"
              min={min}
              max={max}
              className="font-mono"
              value={form[field]}
              disabled={disabled}
              error={problems[field]}
              onChange={(e) => onChange({ [field]: e.target.value })}
            />
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          Hop and pair exchange budgets apply to later messages. Wake budgets
          apply at the next dispatch.
        </p>
      </fieldset>
    </>
  );
}

const CreateValue = RoomForm.extend({ id: z.string() });
const CreateCommand = z.object({
  id: z.string(),
  name: z.string(),
  history_policy: z.enum(["members", "project"]),
  delivery_ttl_seconds: z.number(),
  budgets: z.object({
    max_hops: z.number(),
    pair_exchanges: z.number(),
    agent_wakes: z.number(),
    room_wakes: z.number(),
  }),
});

/** Create a room. Members are added from its editor afterwards. */
export function CreateRoomDrawer({
  project,
  principal,
  onClose,
  onCreated,
}: {
  project: string;
  principal: string | null;
  onClose: () => void;
  onCreated: (room: Room) => void;
}) {
  const invalidate = useInvalidateSettings();
  const { draft, update, discard } = useOperationDraft(
    operationKey("room-create", principal, project),
    () => ({ id: "", ...DEFAULT_FORM }),
    { value: CreateValue, command: CreateCommand },
  );
  const [submitted, setSubmitted] = useState(false);
  const create = useMutation({
    networkMode: "always",
    mutationFn: (op: { id: string; command: RoomCreate }) =>
      createRoom(project, op.command, op.id),
    onSuccess: (result) => {
      discard();
      void invalidate.rooms();
      onCreated(result.room);
    },
    onError: (error) => {
      const kind = failureKind(error);
      if (kind === "forbidden") void invalidate.access();
      if (kind !== "unconfirmed") update(releaseOperation);
    },
  });
  const { id: rawId, ...form } = draft.value;
  const id = rawId.trim();
  const problems: Problems = {
    ...roomProblems(form),
    ...(AgentIdSchema.safeParse(id).success
      ? {}
      : {
          id: id
            ? "Use 1–64 lowercase letters, digits, dots, underscores or hyphens, starting with a letter or digit."
            : "Enter an ID.",
        }),
  };
  const blocked = Object.keys(problems).length > 0;
  const locked = create.isPending || Boolean(draft.pending);
  const shown = submitted ? problems : {};
  const code = create.error instanceof ApiError ? create.error.code : null;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (draft.pending) return create.mutate(draft.pending);
    setSubmitted(true);
    if (blocked) return;
    const next = stageOperation(draft, (v) => ({
      id,
      name: v.name.trim(),
      history_policy: v.history_policy,
      delivery_ttl_seconds: Number(v.ttl),
      budgets: budgets(v),
    }));
    update(() => next);
    if (next.pending) create.mutate(next.pending);
  }

  return (
    <Drawer title="Create room" onClose={onClose}>
      <form className="space-y-4 p-6" onSubmit={submit} noValidate>
        <TextField
          label="ID"
          required
          autoFocus
          className="font-mono"
          spellCheck={false}
          value={rawId}
          disabled={locked}
          error={shown.id}
          hint="Permanent. Lowercase letters, digits, dots, underscores and hyphens."
          onChange={(e) =>
            update((d) => editOperation(d, { ...d.value, id: e.target.value }))
          }
        />
        <RoomSettingsFields
          form={form}
          problems={shown}
          disabled={locked}
          onChange={(change) =>
            update((d) => editOperation(d, { ...d.value, ...change }))
          }
        />
        {code === "conflict" ? (
          <FormNotice>
            A room with this ID already exists with other settings. Choose
            another ID, or edit the existing room.
          </FormNotice>
        ) : code === "room-archived" ? (
          <FormNotice>
            This ID belongs to an archived room. Unarchive it from the list
            instead.
          </FormNotice>
        ) : (
          <WriteFailure error={create.error} action="creation" />
        )}
        {submitted && blocked && (
          <p role="alert" className="text-sm text-status-red">
            Fix the highlighted inputs to create the room.
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-4">
          <Button
            type="button"
            variant="ghost"
            disabled={create.isPending}
            onClick={() => {
              discard();
              onClose();
            }}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={create.isPending}>
            {create.isPending
              ? "Creating…"
              : draft.pending
                ? "Retry creation"
                : "Create room"}
          </Button>
        </div>
      </form>
    </Drawer>
  );
}

/** The newer of two copies of a room (list and detail poll separately). */
const newest = (a: Room, b: Room | undefined) =>
  b && b.revision > a.revision ? b : a;

/**
 * Edit one room. Settings are a copy saved against the revision it opened on;
 * member changes are written one at a time, each naming the room's latest
 * known revision.
 */
export function RoomEditor({
  project,
  principal,
  room: listed,
  onClose,
  onSaved,
}: {
  project: string;
  principal: string | null;
  room: Room;
  onClose: () => void;
  onSaved: (room: Room) => void;
}) {
  const invalidate = useInvalidateSettings();
  const detail = useRoomDetail(listed.id);
  // Our own member writes answer with the new revision before a re-read.
  const [written, setWritten] = useState<Room | undefined>();
  const room = newest(newest(listed, detail.data?.room), written);
  const draft = useSettingsDraft({
    key: operationKey("room-settings", principal, project, room.id),
    current: { revision: room.revision, form: toForm(room) },
    canonical,
    schemas: { form: RoomForm, command: UpdateRoomSchema },
  });
  const [submitted, setSubmitted] = useState(false);
  const [askWiden, setAskWiden] = useState(false);
  const save = useMutation({
    networkMode: "always",
    mutationFn: (op: { id: string; command: UpdateRoom }) =>
      updateRoom(project, room.id, op.command, op.id),
    onSuccess: (result) => {
      draft.discard();
      void invalidate.rooms();
      onSaved(result.room);
    },
    onError: (error) => {
      const kind = failureKind(error);
      if (kind === "forbidden") void invalidate.access();
      if (kind !== "unconfirmed") draft.release();
      if (kind === "conflict") void invalidate.rooms();
    },
  });

  const form = draft.form;
  const problems = roomProblems(form);
  const blocked = Object.keys(problems).length > 0;
  const conflict = revisionConflict(save.error);
  const unrevisioned = room.revision === 0;
  const locked = save.isPending || Boolean(draft.pending) || unrevisioned;
  const widening =
    draft.base.history_policy === "members" &&
    form.history_policy === "project";

  function send() {
    setAskWiden(false);
    const staged = draft.stage(buildUpdate);
    if (staged) save.mutate(staged);
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (draft.pending) return save.mutate(draft.pending);
    setSubmitted(true);
    if (blocked || !draft.dirty || unrevisioned) return;
    if (widening) return setAskWiden(true);
    send();
  }

  return (
    <Drawer title={`Room ${room.id}`} onClose={onClose}>
      <form className="space-y-6 p-6" onSubmit={submit} noValidate>
        <EditorSection title="Identity">
          <Facts
            label="Identity"
            rows={[
              ["ID", room.id],
              ["Created", formatDateTime(room.created_at)],
              ["Revision", String(room.revision)],
              ["State", room.archived ? "Archived" : "Active"],
            ]}
          />
        </EditorSection>
        <EditorSection
          title="Settings"
          description="Saved together as the room's next revision."
        >
          {unrevisioned && (
            <FormNotice tone="info">
              This server does not report room revisions, so changes cannot be
              checked against concurrent edits. Update the server to edit rooms
              here.
            </FormNotice>
          )}
          {draft.stale ? (
            <LandedNotice
              revision={room.revision}
              changed={draft.landed.map((field) => ROOM_FIELD_LABELS[field])}
              onKeepMine={() => {
                save.reset();
                draft.keepMine();
              }}
              onLoadLatest={() => {
                save.reset();
                setAskWiden(false);
                draft.discard();
              }}
            />
          ) : (
            conflict && <LandedNotice revision={null} changed={[]} />
          )}
          <RoomSettingsFields
            form={form}
            problems={submitted ? problems : {}}
            disabled={locked}
            onChange={(change) => {
              setAskWiden(false);
              draft.edit((f) => ({ ...f, ...change }));
            }}
          />
          {askWiden && (
            <FormNotice tone="warning">
              <span className="block">
                Every project reader will be able to read this room's past
                messages immediately, not only its members.
              </span>
              <span className="mt-2 flex flex-wrap gap-2">
                <Button type="button" size="sm" onClick={send}>
                  Widen and save
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setAskWiden(false);
                    draft.edit((f) => ({ ...f, history_policy: "members" }));
                  }}
                >
                  Keep members only
                </Button>
              </span>
            </FormNotice>
          )}
          <WriteFailure error={save.error} action="save" />
          {submitted && blocked && (
            <p role="alert" className="text-sm text-status-red">
              Fix the highlighted inputs to save.
            </p>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              disabled={save.isPending}
              onClick={() => {
                draft.discard();
                onClose();
              }}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={
                save.isPending ||
                unrevisioned ||
                askWiden ||
                (!draft.pending && !draft.dirty)
              }
            >
              {save.isPending
                ? "Saving…"
                : draft.pending
                  ? "Retry save"
                  : "Save settings"}
            </Button>
          </div>
        </EditorSection>
      </form>
      <div className="space-y-3 border-t border-border p-6">
        <MembersEditor
          project={project}
          room={room}
          members={detail.data?.members}
          loading={detail.isPending}
          readOnly={unrevisioned}
          onChanged={(before, after) => {
            draft.advance(before, after.revision);
            setWritten(after);
            void invalidate.rooms();
          }}
        />
      </div>
    </Drawer>
  );
}

type MemberCommand =
  | { kind: "set"; member: string; wake: boolean; expected: number }
  | { kind: "remove"; member: string; expected: number };

function MembersEditor({
  project,
  room,
  members,
  loading,
  readOnly,
  onChanged,
}: {
  project: string;
  room: Room;
  members: Array<{ member: string; wake: boolean }> | undefined;
  loading: boolean;
  readOnly: boolean;
  onChanged: (before: number, after: Room) => void;
}) {
  const invalidate = useInvalidateSettings();
  const [kind, setKind] = useState<"agent" | "principal">("agent");
  const [id, setId] = useState("");
  const [wake, setWake] = useState(true);
  const [problem, setProblem] = useState<string | null>(null);
  const command = useRetryableCommand(
    (op: MemberCommand, key: string) =>
      op.kind === "set"
        ? setRoomMember(
            project,
            room.id,
            op.member,
            { wake: op.wake, expected_revision: op.expected },
            key,
          )
        : removeRoomMember(project, room.id, op.member, op.expected, key),
    {
      onSuccess: (result, op) => {
        if (op.kind === "set" && op.member === `${kind}:${id.trim()}`)
          setId("");
        onChanged(op.expected, result.room);
      },
      onError: (error) => {
        const failure = failureKind(error);
        if (failure === "forbidden") void invalidate.access();
        if (failure === "conflict") void invalidate.rooms();
      },
    },
  );
  const busy = command.pending || readOnly;
  const send = (op: MemberCommand) => {
    setProblem(null);
    command.send(op);
  };

  function add(event: FormEvent) {
    event.preventDefault();
    const value = id.trim();
    const member = `${kind}:${value}`;
    if (!value) return setProblem("Enter an ID.");
    if (kind === "agent" && !AgentIdSchema.safeParse(value).success)
      return setProblem("Enter an agent ID (lowercase, as registered).");
    if (member.length > 256) return setProblem("Use at most 256 characters.");
    send({ kind: "set", member, wake, expected: room.revision });
  }

  const error = command.error;
  const conflict = revisionConflict(error);
  const code = error instanceof ApiError ? error.code : null;

  return (
    <section aria-labelledby="room-members" className="space-y-3">
      <div>
        <h3 id="room-members" className="text-sm font-medium">
          Members
        </h3>
        <p className="text-xs text-muted-foreground">
          Each change is saved at once and takes effect immediately: who may
          post, who reads a members-only history and who is woken.
        </p>
      </div>
      {loading ? (
        <output className="block text-sm text-muted-foreground">
          Loading members…
        </output>
      ) : !members?.length ? (
        <p className="text-sm text-muted-foreground">No members yet.</p>
      ) : (
        <ul aria-label="Room members" className="divide-y divide-border">
          {members.map((row) => (
            <li
              key={row.member}
              className="flex flex-wrap items-center gap-3 py-2"
            >
              <span className="min-w-0 flex-1 break-all font-mono text-xs">
                {row.member}
              </span>
              <CheckboxField
                label={
                  <>
                    <span aria-hidden="true">Wake</span>
                    <span className="sr-only">{`Wake ${row.member}`}</span>
                  </>
                }
                checked={row.wake}
                disabled={busy}
                onChange={(next) =>
                  send({
                    kind: "set",
                    member: row.member,
                    wake: next,
                    expected: room.revision,
                  })
                }
              />
              <Button
                type="button"
                size="xs"
                variant="ghost"
                className="text-status-red"
                aria-label={`Remove ${row.member}`}
                disabled={busy}
                onClick={() =>
                  send({
                    kind: "remove",
                    member: row.member,
                    expected: room.revision,
                  })
                }
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
      {!readOnly && (
        <form
          aria-label="Add member"
          className="grid gap-3 sm:grid-cols-[auto_minmax(0,1fr)_auto_auto] sm:items-end"
          onSubmit={add}
          noValidate
        >
          <SelectField
            label="Kind"
            value={kind}
            disabled={busy}
            options={[
              { value: "agent", label: "Agent" },
              { value: "principal", label: "Principal" },
            ]}
            onChange={(e) => setKind(e.target.value as "agent" | "principal")}
          />
          <TextField
            label={kind === "agent" ? "Agent ID" : "Principal ID"}
            className="font-mono"
            spellCheck={false}
            value={id}
            disabled={busy}
            error={problem ?? undefined}
            onChange={(e) => setId(e.target.value)}
          />
          <CheckboxField
            label="Wake"
            checked={wake}
            disabled={busy}
            onChange={setWake}
          />
          <Button type="submit" variant="outline" disabled={busy}>
            Add member
          </Button>
        </form>
      )}
      {command.unconfirmed && (
        <FormNotice tone="warning">
          <span className="block">
            The server did not confirm the change to{" "}
            {command.unconfirmed.member}. Retry sends the same request, so it is
            applied at most once.
          </span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="mt-2"
            disabled={command.pending}
            onClick={command.retry}
          >
            Retry member change
          </Button>
        </FormNotice>
      )}
      {!command.unconfirmed &&
        error !== null &&
        (conflict ? (
          <FormNotice>
            The room changed
            {conflict.revision === null
              ? ""
              : ` (revision ${conflict.revision})`}{" "}
            since it was loaded. The members are reloaded; review them and try
            again.
          </FormNotice>
        ) : code === "agent-archived" ? (
          <FormNotice>
            Archived agents cannot join rooms. Unarchive the agent first.
          </FormNotice>
        ) : (
          <WriteFailure error={error} action="member change" />
        ))}
    </section>
  );
}
