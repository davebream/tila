import { SchemaForm, presentationRoles } from "@/components/schema-form";
import { Button } from "@/components/ui/button";
import { Drawer } from "@/components/ui/drawer";
import { FormNotice, TextField } from "@/components/ui/form-fields";
import { useWhoami } from "@/hooks/use-admin";
import { useRecordTypes } from "@/hooks/use-api";
import { useAuth } from "@/hooks/use-auth";
import { createRecord, getRecord, putRecord } from "@/lib/api";
import { fromRaw, rawFields } from "@/lib/field-values";
import { failureKind, failureMessage } from "@/lib/mutation-errors";
import {
  editOperation,
  operationKey,
  releaseOperation,
  stageOperation,
  useOperationDraft,
} from "@/lib/operation-draft";
import { rights } from "@/lib/rights";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { RecordCatalogDefinition, RecordItem } from "@tila/schemas";
import { type FormEvent, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { z } from "zod";

const sameJson = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

/** Drop cleared fields: a full-replace write omits them instead of storing null. */
function withoutNulls(data: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(data).filter(([, value]) => value !== null),
  );
}

function invalidateRecords(
  client: ReturnType<typeof useQueryClient>,
  project: string,
) {
  return Promise.all(
    ["record", "record-page", "recordHistory", "recordTypes"].map((key) =>
      client.invalidateQueries({ queryKey: [key, project] }),
    ),
  );
}

const CreateValue = z.object({
  key: z.string(),
  fields: z.record(z.string(), z.string()),
  message: z.string(),
});
const CreateCommand = z.object({
  key: z.string(),
  value: z.record(z.string(), z.unknown()),
  message: z.string().optional(),
});

/** `?create=record&type=<type>` on the records page. */
export function RecordCreateDrawer() {
  const { projectId } = useAuth();
  const project = projectId ?? "";
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const type = searchParams.get("type") ?? "";
  const client = useQueryClient();
  const whoami = useWhoami();
  const allowed = rights(whoami.data, project);
  const types = useRecordTypes();
  const entry = types.data?.entries?.find((e) => e.type === type);
  const definition =
    entry?.declaration === "declared" ? entry.definition : undefined;
  const fields = definition?.fields ?? [];
  const { draft, update, discard } = useOperationDraft(
    whoami.data?.principal_id
      ? operationKey("record-create", whoami.data.principal_id, project, type)
      : null,
    () => ({ key: "", fields: {}, message: "" }),
    { value: CreateValue, command: CreateCommand },
  );
  const value = draft.value;
  // Declared defaults fill any field the draft has not touched yet (the
  // draft may start before the type definitions load).
  const fieldValues = { ...rawFields(fields, null), ...value.fields };
  const [errors, setErrors] = useState<Record<string, string>>({});
  const close = () => {
    const next = new URLSearchParams(searchParams);
    next.delete("create");
    setSearchParams(next);
  };

  const submit = useMutation({
    mutationFn: async ({
      staged,
      retry,
    }: {
      staged: NonNullable<typeof draft.pending>;
      retry: boolean;
    }) => {
      const command = staged.command;
      try {
        await createRecord(
          project,
          type,
          {
            key: command.key,
            value: command.value,
            ...(command.message ? { message: command.message } : {}),
          },
          staged.id,
        );
      } catch (error) {
        // Only a retry can meet its own earlier create (the response was
        // lost); then the same value means done. A first send that conflicts
        // found someone else's record.
        if (!retry || failureKind(error) !== "conflict") throw error;
        const existing = await getRecord(project, type, command.key);
        if (!sameJson(existing.record.value, command.value)) throw error;
      }
      return command.key;
    },
    onSuccess: async (key) => {
      await invalidateRecords(client, project);
      discard();
      navigate(
        `/p/${project}/records/${type}/${key}?type=${encodeURIComponent(type)}`,
      );
    },
    onError: (error) => {
      if (failureKind(error) === "forbidden")
        void client.invalidateQueries({ queryKey: ["whoami", project] });
      if (failureKind(error) !== "unconfirmed") update(releaseOperation);
    },
  });

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (draft.pending)
      return submit.mutate({ staged: draft.pending, retry: true });
    const key = value.key.trim();
    if (!key) return setErrors({ key: "Enter a key." });
    if (!allowed.writeRecord(type, key))
      return setErrors({ key: "This credential cannot write that key." });
    const converted = fromRaw(fields, fieldValues);
    if (!converted.ok) return setErrors(converted.errors);
    setErrors({});
    const next = stageOperation(draft, () => ({
      key,
      value: withoutNulls(converted.data),
      ...(value.message.trim() ? { message: value.message.trim() } : {}),
    }));
    update(() => next);
    if (next.pending) submit.mutate({ staged: next.pending, retry: false });
  }

  const kind = submit.isError ? failureKind(submit.error) : null;
  const busy = submit.isPending;
  const locked = busy || Boolean(draft.pending);
  return (
    <Drawer title={`New ${type} record`} onClose={close}>
      <form className="space-y-4 p-6" onSubmit={onSubmit} noValidate>
        {!definition && types.data && (
          <FormNotice tone="info">
            Type <code className="font-mono">{type}</code> is not declared by
            the current schema, so new records cannot be created here.
          </FormNotice>
        )}
        {definition && (
          <>
            <TextField
              label="Key"
              required
              className="font-mono"
              hint={definition.key_description}
              value={value.key}
              error={errors.key}
              disabled={locked}
              onChange={(e) =>
                update((d) =>
                  editOperation(d, { ...d.value, key: e.target.value }),
                )
              }
            />
            <SchemaForm
              fields={fields}
              values={fieldValues}
              errors={errors}
              disabled={locked}
              roles={presentationRoles(definition.presentation)}
              onChange={(name, v) =>
                update((d) =>
                  editOperation(d, {
                    ...d.value,
                    fields: { ...d.value.fields, [name]: v },
                  }),
                )
              }
            />
            <TextField
              label="Change note"
              hint="Optional. Kept in the record's history."
              value={value.message}
              disabled={locked}
              onChange={(e) =>
                update((d) =>
                  editOperation(d, { ...d.value, message: e.target.value }),
                )
              }
            />
          </>
        )}
        <RecordFailure kind={kind} error={submit.error} creating />
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            disabled={busy}
            onClick={() => {
              discard();
              close();
            }}
          >
            Discard
          </Button>
          <Button
            type="submit"
            disabled={busy || !definition || !allowed.writeRecord(type)}
          >
            {busy ? "Creating…" : draft.pending ? "Retry" : "Create record"}
          </Button>
        </div>
      </form>
    </Drawer>
  );
}

function RecordFailure({
  kind,
  error,
  creating,
}: {
  kind: ReturnType<typeof failureKind> | null;
  error: unknown;
  creating?: boolean;
}) {
  if (!kind) return null;
  if (kind === "unconfirmed")
    return (
      <FormNotice tone="warning">
        The server did not confirm this write ({failureMessage(error)}). Retry
        sends the same request, so it is applied at most once.
      </FormNotice>
    );
  if (kind === "conflict")
    return (
      <FormNotice>
        {creating
          ? "A record with this key already exists with a different value. Choose another key."
          : "This record changed since you started editing. Nothing was saved and your draft is kept. Review the latest value, then keep your draft on it to save again."}
      </FormNotice>
    );
  if (kind === "forbidden")
    return (
      <FormNotice>
        Your access changed and the write was refused. Your input is kept.
      </FormNotice>
    );
  return <FormNotice>{failureMessage(error)} Your input is kept.</FormNotice>;
}

const EditValue = z.object({
  fields: z.record(z.string(), z.string()),
  message: z.string(),
  /** The record fence (write counter) the draft was started from. */
  fence: z.number(),
});
const EditCommand = z.object({
  value: z.record(z.string(), z.unknown()),
  fence: z.number(),
  message: z.string().optional(),
});

/**
 * Full-replace edit of a declared record at the fence it was loaded with.
 * Undeclared keys in the stored value are carried over unchanged. A write at a
 * stale fence is rejected by the server and the draft is kept for review.
 */
export function RecordEditForm({
  record,
  fence,
  definition,
  principal,
  onClose,
}: {
  record: RecordItem;
  fence: number;
  definition: RecordCatalogDefinition;
  principal: string;
  onClose: () => void;
}) {
  const { projectId } = useAuth();
  const project = projectId ?? "";
  const client = useQueryClient();
  const fields = definition.fields;
  const { draft, update, discard } = useOperationDraft(
    operationKey("record-edit", principal, project, record.type, record.key),
    () => ({ fields: rawFields(fields, record.value), message: "", fence }),
    { value: EditValue, command: EditCommand },
  );
  const value = draft.value;
  const [errors, setErrors] = useState<Record<string, string>>({});
  const stale = value.fence !== fence;

  const save = useMutation({
    mutationFn: async (staged: NonNullable<typeof draft.pending>) =>
      putRecord(
        project,
        record.type,
        record.key,
        {
          value: staged.command.value,
          fence: staged.command.fence,
          ...(staged.command.message
            ? { message: staged.command.message }
            : {}),
        },
        staged.id,
      ),
    onSuccess: async () => {
      await invalidateRecords(client, project);
      discard();
      onClose();
    },
    onError: (error) => {
      if (failureKind(error) === "forbidden")
        void client.invalidateQueries({ queryKey: ["whoami", project] });
      if (failureKind(error) !== "unconfirmed") update(releaseOperation);
    },
  });

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (draft.pending) return save.mutate(draft.pending);
    const converted = fromRaw(fields, value.fields, { previous: record.value });
    if (!converted.ok) return setErrors(converted.errors);
    setErrors({});
    const declared = new Set(fields.map((f) => f.name));
    const kept = Object.fromEntries(
      Object.entries(record.value).filter(([name]) => !declared.has(name)),
    );
    const next = stageOperation(draft, () => ({
      value: { ...kept, ...withoutNulls(converted.data) },
      fence: value.fence,
      ...(value.message.trim() ? { message: value.message.trim() } : {}),
    }));
    update(() => next);
    if (next.pending) save.mutate(next.pending);
  }

  const kind = save.isError ? failureKind(save.error) : null;
  const busy = save.isPending;
  const locked = busy || Boolean(draft.pending);
  return (
    <form className="space-y-4" onSubmit={onSubmit} noValidate>
      {stale && (
        <FormNotice tone="warning">
          This record changed after your draft started (fence {value.fence} →{" "}
          {fence}). Compare with the latest value, then{" "}
          <Button
            type="button"
            size="xs"
            variant="outline"
            onClick={() =>
              update((d) => editOperation(d, { ...d.value, fence }))
            }
          >
            Keep my draft on the latest version
          </Button>{" "}
          or{" "}
          <Button type="button" size="xs" variant="ghost" onClick={discard}>
            Start over from the latest
          </Button>
        </FormNotice>
      )}
      <SchemaForm
        fields={fields}
        values={value.fields}
        errors={errors}
        disabled={locked}
        roles={presentationRoles(definition.presentation)}
        onChange={(name, v) =>
          update((d) =>
            editOperation(d, {
              ...d.value,
              fields: { ...d.value.fields, [name]: v },
            }),
          )
        }
      />
      <TextField
        label="Change note"
        hint="Optional. Kept in the record's history."
        value={value.message}
        disabled={locked}
        onChange={(e) =>
          update((d) =>
            editOperation(d, { ...d.value, message: e.target.value }),
          )
        }
      />
      <RecordFailure kind={kind} error={save.error} />
      <div className="flex flex-wrap justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          disabled={busy}
          onClick={() => {
            discard();
            onClose();
          }}
        >
          Discard changes
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          onClick={onClose}
          title="Close the editor and keep the draft in this browser tab"
        >
          Keep draft
        </Button>
        <Button type="submit" disabled={busy || (stale && !draft.pending)}>
          {busy ? "Saving…" : draft.pending ? "Retry save" : "Save"}
        </Button>
      </div>
    </form>
  );
}
