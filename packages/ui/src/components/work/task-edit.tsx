import { SchemaForm, presentationRoles } from "@/components/schema-form";
import { Button } from "@/components/ui/button";
import { FormNotice, TextField } from "@/components/ui/form-fields";
import { useAuth } from "@/hooks/use-auth";
import {
  ApiError,
  acquireClaim,
  getTaskDetail,
  patchTask,
  releaseClaim,
} from "@/lib/api";
import {
  type RawFields,
  changedData,
  fromRaw,
  rawFields,
} from "@/lib/field-values";
import { failureKind, failureMessage } from "@/lib/mutation-errors";
import {
  editOperation,
  operationKey,
  releaseOperation,
  stageOperation,
  useOperationDraft,
} from "@/lib/operation-draft";
import { formatDateTime } from "@/lib/time";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Entity, WorkCatalogEntry } from "@tila/schemas";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { z } from "zod";

/** Long enough to edit by hand; saving re-acquires, which extends it. */
const EDIT_CLAIM_TTL_MS = 10 * 60 * 1000;

const DraftValue = z.object({
  fields: z.record(z.string(), z.string()),
  tags: z.string(),
  /** `updated_at` of the version the user started from. */
  base: z.number(),
});
type DraftValue = z.infer<typeof DraftValue>;

const Command = z.object({
  data: z.record(z.string(), z.unknown()),
  tags: z.array(z.string()).optional(),
  managed: z.boolean(),
  base: z.number(),
});
type Command = z.infer<typeof Command>;

type Lease = { fence: number; expires_at: number } | null;

class ChangedElsewhere extends Error {
  constructor() {
    super("This task changed after you started editing.");
  }
}

interface TaskEditFormProps {
  entity: Entity;
  definition: NonNullable<WorkCatalogEntry["definition"]>;
  /** Queue-managed work: content only, lifecycle stays with the attempt. */
  managed: boolean;
  principal: string;
  onClose: () => void;
  /** The server says this task is queue-managed after all. */
  onManaged: () => void;
}

/**
 * Edits one task's declared fields. Unmanaged tasks are edited under an
 * exclusive claim whose fence the PATCH carries; a save first re-checks that
 * nobody changed the task since the form opened, so a stale edit becomes a
 * visible conflict with the draft kept instead of a silent overwrite.
 */
export function TaskEditForm({
  entity,
  definition,
  managed,
  principal,
  onClose,
  onManaged,
}: TaskEditFormProps) {
  const { projectId } = useAuth();
  const project = projectId ?? "";
  const client = useQueryClient();
  const resource = `${entity.type}:${entity.id}`;
  const lifecycleField = definition.lifecycle?.field;
  const hidden = new Set(managed && lifecycleField ? [lifecycleField] : []);
  const fields = definition.fields;
  const { draft, update, discard } = useOperationDraft<DraftValue, Command>(
    operationKey("task-edit", principal, project, entity.id),
    () => ({
      fields: rawFields(fields, entity.data),
      tags: (entity.tags ?? []).join(", "),
      base: entity.updated_at,
    }),
    { value: DraftValue, command: Command },
  );
  const value = draft.value;
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [lease, setLease] = useState<Lease>(null);
  const leaseRef = useRef<Lease>(null);
  leaseRef.current = lease;
  const stale = value.base !== entity.updated_at;

  const claim = useMutation({
    mutationFn: () =>
      acquireClaim(project, {
        resource,
        mode: "exclusive",
        ttl_ms: EDIT_CLAIM_TTL_MS,
        metadata: { purpose: "dashboard-edit" },
      }),
    onSuccess: (result) => setLease(result),
    onError: (error) => {
      if (error instanceof ApiError && error.code === "queue-managed-work")
        onManaged();
    },
  });

  // Take the claim when an unmanaged edit opens; give it back when it closes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per form
  useEffect(() => {
    if (!managed) claim.mutate();
    return () => {
      const held = leaseRef.current;
      if (held)
        void releaseClaim(project, { resource, fence: held.fence }).catch(
          () => undefined, // Expiry releases it anyway.
        );
    };
  }, [managed]);

  const save = useMutation({
    mutationFn: async (staged: NonNullable<typeof draft.pending>) => {
      const command = staged.command;
      let fence = 0;
      if (!command.managed) {
        // Re-acquiring as the holder extends the claim and returns its fence.
        const held = await acquireClaim(project, {
          resource,
          mode: "exclusive",
          ttl_ms: EDIT_CLAIM_TTL_MS,
          metadata: { purpose: "dashboard-edit" },
        });
        setLease(held);
        fence = held.fence;
      }
      const current = await getTaskDetail(project, entity.id);
      // A retry of our own write sees our update_at, which is not a conflict.
      if (
        current.entity.updated_at !== command.base &&
        JSON.stringify(
          changedData(
            command.data,
            current.entity.data as Record<string, unknown>,
          ),
        ) !== "{}"
      )
        throw new ChangedElsewhere();
      return patchTask(
        project,
        entity.id,
        {
          data: command.data,
          fence,
          ...(command.tags ? { tags: command.tags } : {}),
        },
        staged.id,
      );
    },
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: ["task", project, entity.id] }),
        client.invalidateQueries({ queryKey: ["task-history", project] }),
        client.invalidateQueries({ queryKey: ["task-page", project] }),
        client.invalidateQueries({ queryKey: ["claims", project] }),
      ]);
      discard();
      onClose();
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === "queue-managed-work") {
        update(releaseOperation);
        onManaged();
        return;
      }
      const kind = failureKind(error);
      if (kind === "forbidden")
        void client.invalidateQueries({ queryKey: ["whoami", project] });
      if (error instanceof ChangedElsewhere || kind !== "unconfirmed")
        update(releaseOperation);
    },
  });

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (draft.pending) return save.mutate(draft.pending);
    const raw: RawFields = value.fields;
    const converted = fromRaw(fields, raw, {
      previous: entity.data,
      skip: hidden,
    });
    if (!converted.ok) return setErrors(converted.errors);
    setErrors({});
    const data = changedData(converted.data, entity.data);
    const tags = value.tags
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    const tagsChanged = tags.join("\n") !== (entity.tags ?? []).join("\n");
    if (Object.keys(data).length === 0 && !tagsChanged) {
      discard();
      onClose();
      return;
    }
    const next = stageOperation(draft, () => ({
      data,
      ...(tagsChanged ? { tags } : {}),
      managed,
      base: value.base,
    }));
    update(() => next);
    if (next.pending) save.mutate(next.pending);
  }

  const blocked =
    !managed &&
    claim.isError &&
    !(
      claim.error instanceof ApiError &&
      claim.error.code === "queue-managed-work"
    );
  const ready = managed || lease !== null;
  const busy = save.isPending;
  const locked = busy || Boolean(draft.pending) || !ready;
  const saveError = save.error;
  const saveKind =
    save.isError && !(saveError instanceof ChangedElsewhere)
      ? failureKind(saveError)
      : null;

  return (
    <form className="space-y-4" onSubmit={onSubmit} noValidate>
      {managed ? (
        <FormNotice tone="info">
          This task is in the work queue. You can edit its content; its{" "}
          {lifecycleField ? (
            <code className="font-mono">{lifecycleField}</code>
          ) : (
            "state"
          )}{" "}
          changes only through its attempt.
        </FormNotice>
      ) : claim.isPending ? (
        <FormNotice tone="info">Claiming this task for editing…</FormNotice>
      ) : blocked ? (
        <FormNotice>
          {failureKind(claim.error) === "conflict"
            ? "Someone else holds this task's claim, so it cannot be edited right now. Your draft is kept; try again after their claim is released or expires."
            : `Editing needs a claim on this task: ${failureMessage(claim.error)}`}{" "}
          <Button
            type="button"
            size="xs"
            variant="outline"
            onClick={() => claim.mutate()}
          >
            Try again
          </Button>
        </FormNotice>
      ) : lease ? (
        <p className="text-xs text-muted-foreground">
          You hold the edit claim until {formatDateTime(lease.expires_at)}.
          Saving extends it.
        </p>
      ) : null}

      {stale && (
        <FormNotice tone="warning">
          This task changed after your draft started. Review the latest values
          shown elsewhere in this drawer, then{" "}
          <Button
            type="button"
            size="xs"
            variant="outline"
            onClick={() =>
              update((d) =>
                editOperation(d, { ...d.value, base: entity.updated_at }),
              )
            }
          >
            Keep my draft on the latest version
          </Button>{" "}
          or{" "}
          <Button
            type="button"
            size="xs"
            variant="ghost"
            onClick={() => {
              discard();
              setErrors({});
            }}
          >
            Start over from the latest
          </Button>
        </FormNotice>
      )}

      <SchemaForm
        fields={fields}
        values={value.fields}
        errors={errors}
        hidden={hidden}
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
        label="Tags"
        hint="Comma separated."
        value={value.tags}
        disabled={locked}
        onChange={(e) =>
          update((d) => editOperation(d, { ...d.value, tags: e.target.value }))
        }
      />

      {saveError instanceof ChangedElsewhere && (
        <FormNotice>
          {saveError.message} Nothing was saved and your draft is kept. Compare
          it with the latest values, then keep your draft on the latest version
          to save again.
        </FormNotice>
      )}
      {saveKind === "unconfirmed" && (
        <FormNotice tone="warning">
          The server did not confirm the save ({failureMessage(saveError)}).
          Retry sends the same change, so it is applied at most once.
        </FormNotice>
      )}
      {saveKind === "conflict" && (
        <FormNotice>
          {failureMessage(saveError)} Your draft is kept. Your edit claim may
          have expired or been taken; save again to re-claim, or start over from
          the latest.
        </FormNotice>
      )}
      {saveKind === "invalid" && (
        <FormNotice>{failureMessage(saveError)} Your draft is kept.</FormNotice>
      )}
      {saveKind === "forbidden" && (
        <FormNotice>
          Your access changed and the save was refused. Your draft is kept.
        </FormNotice>
      )}

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
        <Button
          type="submit"
          disabled={busy || !ready || (stale && !draft.pending)}
        >
          {busy ? "Saving…" : draft.pending ? "Retry save" : "Save"}
        </Button>
      </div>
    </form>
  );
}
