import { EditorSection } from "@/components/definitions/controls";
import {
  Facts,
  LandedNotice,
  WriteFailure,
  uniqueLines,
} from "@/components/settings/settings-ui";
import { Button } from "@/components/ui/button";
import { Drawer } from "@/components/ui/drawer";
import {
  FormNotice,
  TextAreaField,
  TextField,
} from "@/components/ui/form-fields";
import { useInvalidateSettings } from "@/hooks/use-identities";
import { putSignalGroup } from "@/lib/api";
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
import { type SignalGroup, SignalGroupIdSchema } from "@tila/schemas";
import { type FormEvent, useState } from "react";
import { z } from "zod";

const GroupForm = z.object({
  name: z.string(),
  /** Principal IDs, one per line. */
  principals: z.string(),
});
type GroupForm = z.infer<typeof GroupForm>;

const GroupCommand = z.object({
  name: z.string(),
  principal_ids: z.array(z.string()),
  expected_revision: z.number(),
});
type GroupCommand = z.infer<typeof GroupCommand>;

const FIELD_LABELS: Record<keyof GroupForm, string> = {
  name: "the name",
  principals: "the members",
};

const PRINCIPALS_HINT =
  "One principal ID per line. Changes reach only signals sent afterwards; signals already sent keep their recipients.";

function toForm(group: SignalGroup): GroupForm {
  return { name: group.name, principals: group.principal_ids.join("\n") };
}

function canonical(form: GroupForm) {
  return { name: form.name.trim(), principals: uniqueLines(form.principals) };
}

type Problems = Partial<Record<"id" | "name" | "principals", string>>;

function groupProblems(form: GroupForm): Problems {
  const found: Problems = {};
  const { name, principals } = canonical(form);
  if (!name) found.name = "Enter a name.";
  else if (name.length > 128) found.name = "Use at most 128 characters.";
  if (principals.length > 500)
    found.principals = "List at most 500 principals.";
  else if (principals.some((p) => p.length > 2048))
    found.principals = "Each principal ID has at most 2048 characters.";
  return found;
}

/** The full replacement the PUT needs, against the copy's revision. */
function buildPut(copy: SettingsCopy<GroupForm>): GroupCommand {
  const { name, principals } = canonical(copy.form);
  return { name, principal_ids: principals, expected_revision: copy.revision };
}

/** Edit a group's name and members against the revision it opened on. */
export function SignalGroupEditor({
  project,
  principal,
  group,
  onClose,
  onSaved,
}: {
  project: string;
  principal: string | null;
  group: SignalGroup;
  onClose: () => void;
  onSaved: (group: SignalGroup) => void;
}) {
  const invalidate = useInvalidateSettings();
  const draft = useSettingsDraft({
    key: operationKey("signal-group-settings", principal, project, group.id),
    current: { revision: group.revision, form: toForm(group) },
    canonical,
    schemas: { form: GroupForm, command: GroupCommand },
  });
  const [submitted, setSubmitted] = useState(false);
  const save = useMutation({
    networkMode: "always",
    mutationFn: (op: { id: string; command: GroupCommand }) =>
      putSignalGroup(project, group.id, op.command, op.id),
    onSuccess: (result) => {
      draft.discard();
      void invalidate.groups();
      onSaved(result.group);
    },
    onError: (error) => {
      const kind = failureKind(error);
      if (kind === "forbidden") void invalidate.access();
      if (kind !== "unconfirmed") draft.release();
      if (kind === "conflict") void invalidate.groups();
    },
  });
  const form = draft.form;
  const problems = groupProblems(form);
  const blocked = Object.keys(problems).length > 0;
  const conflict = revisionConflict(save.error);
  const unrevisioned = group.revision === 0;
  const locked = save.isPending || Boolean(draft.pending) || unrevisioned;
  const shown = submitted ? problems : {};

  function submit(event: FormEvent) {
    event.preventDefault();
    if (draft.pending) return save.mutate(draft.pending);
    setSubmitted(true);
    if (blocked || !draft.dirty || unrevisioned) return;
    const staged = draft.stage(buildPut);
    if (staged) save.mutate(staged);
  }

  return (
    <Drawer title={`Signal group ${group.id}`} onClose={onClose}>
      <form className="space-y-6 p-6" onSubmit={submit} noValidate>
        <EditorSection title="Identity">
          <Facts
            label="Identity"
            rows={[
              ["ID", group.id],
              ["Created", formatDateTime(group.created_at)],
              ["Revision", String(group.revision)],
            ]}
          />
        </EditorSection>
        <EditorSection
          title="Settings"
          description="Saved together as the group's next revision."
        >
          {unrevisioned && (
            <FormNotice tone="info">
              This server does not report group revisions, so changes cannot be
              checked against concurrent edits. Update the server to edit groups
              here.
            </FormNotice>
          )}
          {conflict && conflict.revision === null ? (
            <FormNotice>
              This group was deleted meanwhile; nothing was saved.
            </FormNotice>
          ) : draft.stale ? (
            <LandedNotice
              revision={group.revision}
              changed={draft.landed.map((field) => FIELD_LABELS[field])}
              onKeepMine={() => {
                save.reset();
                draft.keepMine();
              }}
              onLoadLatest={() => {
                save.reset();
                draft.discard();
              }}
            />
          ) : (
            conflict && <LandedNotice revision={null} changed={[]} />
          )}
          <TextField
            label="Name"
            required
            value={form.name}
            disabled={locked}
            error={shown.name}
            onChange={(e) => {
              const name = e.target.value;
              draft.edit((f) => ({ ...f, name }));
            }}
          />
          <TextAreaField
            label="Members"
            value={form.principals}
            disabled={locked}
            spellCheck={false}
            className="font-mono text-xs"
            error={shown.principals}
            hint={PRINCIPALS_HINT}
            onChange={(e) => {
              const principals = e.target.value;
              draft.edit((f) => ({ ...f, principals }));
            }}
          />
        </EditorSection>
        <WriteFailure error={save.error} action="save" />
        {submitted && blocked && (
          <p role="alert" className="text-sm text-status-red">
            Fix the highlighted inputs to save.
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-4">
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
              save.isPending || unrevisioned || (!draft.pending && !draft.dirty)
            }
          >
            {save.isPending
              ? "Saving…"
              : draft.pending
                ? "Retry save"
                : "Save changes"}
          </Button>
        </div>
      </form>
    </Drawer>
  );
}

const CreateValue = GroupForm.extend({ id: z.string() });
const CreateCommand = GroupCommand.extend({ id: z.string() });

/** Create a group. Revision 0 means create only: an existing ID conflicts. */
export function CreateSignalGroupDrawer({
  project,
  principal,
  onClose,
  onCreated,
}: {
  project: string;
  principal: string | null;
  onClose: () => void;
  onCreated: (group: SignalGroup) => void;
}) {
  const invalidate = useInvalidateSettings();
  const { draft, update, discard } = useOperationDraft(
    operationKey("signal-group-create", principal, project),
    () => ({ id: "", name: "", principals: "" }),
    { value: CreateValue, command: CreateCommand },
  );
  const [submitted, setSubmitted] = useState(false);
  const create = useMutation({
    networkMode: "always",
    mutationFn: (op: {
      id: string;
      command: z.infer<typeof CreateCommand>;
    }) => {
      const { id, ...body } = op.command;
      return putSignalGroup(project, id, body, op.id);
    },
    onSuccess: (result) => {
      discard();
      void invalidate.groups();
      onCreated(result.group);
    },
    onError: (error) => {
      const kind = failureKind(error);
      if (kind === "forbidden") void invalidate.access();
      if (kind !== "unconfirmed") update(releaseOperation);
      if (kind === "conflict") void invalidate.groups();
    },
  });
  const value = draft.value;
  const id = value.id.trim();
  const problems: Problems = {
    ...groupProblems(value),
    ...(SignalGroupIdSchema.safeParse(id).success
      ? {}
      : {
          id: id
            ? "Use up to 128 letters, digits, dots, underscores or hyphens, starting with a letter or digit."
            : "Enter an ID.",
        }),
  };
  const blocked = Object.keys(problems).length > 0;
  const locked = create.isPending || Boolean(draft.pending);
  const shown = submitted ? problems : {};
  const taken = revisionConflict(create.error);
  const set = (change: Partial<typeof value>) =>
    update((d) => editOperation(d, { ...d.value, ...change }));

  function submit(event: FormEvent) {
    event.preventDefault();
    if (draft.pending) return create.mutate(draft.pending);
    setSubmitted(true);
    if (blocked) return;
    const next = stageOperation(draft, (v) => {
      const { name, principals } = canonical(v);
      return { id, name, principal_ids: principals, expected_revision: 0 };
    });
    update(() => next);
    if (next.pending) create.mutate(next.pending);
  }

  return (
    <Drawer title="Create signal group" onClose={onClose}>
      <form className="space-y-4 p-6" onSubmit={submit} noValidate>
        <TextField
          label="ID"
          required
          autoFocus
          className="font-mono"
          spellCheck={false}
          value={value.id}
          disabled={locked}
          error={shown.id}
          hint="Signals target the group by this ID."
          onChange={(e) => set({ id: e.target.value })}
        />
        <TextField
          label="Name"
          required
          value={value.name}
          disabled={locked}
          error={shown.name}
          onChange={(e) => set({ name: e.target.value })}
        />
        <TextAreaField
          label="Members"
          value={value.principals}
          disabled={locked}
          spellCheck={false}
          className="font-mono text-xs"
          error={shown.principals}
          hint="One principal ID per line."
          onChange={(e) => set({ principals: e.target.value })}
        />
        {taken ? (
          <FormNotice>
            A group with this ID already exists
            {taken.revision === null ? "" : ` (revision ${taken.revision})`}.
            Choose another ID, or edit the existing group from the list.
          </FormNotice>
        ) : (
          <WriteFailure error={create.error} action="creation" />
        )}
        {submitted && blocked && (
          <p role="alert" className="text-sm text-status-red">
            Fix the highlighted inputs to create the group.
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
                : "Create group"}
          </Button>
        </div>
      </form>
    </Drawer>
  );
}
