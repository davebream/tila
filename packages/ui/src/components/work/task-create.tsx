import { SchemaForm, presentationRoles } from "@/components/schema-form";
import { Button } from "@/components/ui/button";
import { Drawer } from "@/components/ui/drawer";
import {
  FormNotice,
  SelectField,
  TextField,
} from "@/components/ui/form-fields";
import { useWhoami } from "@/hooks/use-admin";
import { useWorkCatalog } from "@/hooks/use-api";
import { useAuth } from "@/hooks/use-auth";
import {
  ApiError,
  createTask,
  createTaskRelationship,
  getTaskDetail,
  instantiateTemplate,
  listTemplates,
} from "@/lib/api";
import { type RawFields, fromRaw, rawFields } from "@/lib/field-values";
import { failureKind, failureMessage } from "@/lib/mutation-errors";
import {
  editOperation,
  operationKey,
  releaseOperation,
  stageOperation,
  useOperationDraft,
} from "@/lib/operation-draft";
import { rights } from "@/lib/rights";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CatalogField, WorkCatalogEntry } from "@tila/schemas";
import { type FormEvent, type ReactNode, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { z } from "zod";

/** Matches the MCP default root id; a random tail avoids same-millisecond clashes. */
export function newTaskId(): string {
  const tail = Math.floor(Math.random() * 36 ** 3)
    .toString(36)
    .padStart(3, "0");
  return `T-${Date.now().toString(36)}${tail}`.toUpperCase();
}

const DraftValue = z.object({
  mode: z.enum(["blank", "template"]),
  type: z.string(),
  id: z.string(),
  fields: z.record(z.string(), z.string()),
  parent: z.string(),
  tags: z.string(),
  template: z.string(),
  root_id: z.string(),
  vars: z.record(z.string(), z.string()),
});
type DraftValue = z.infer<typeof DraftValue>;

const Command = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("task"),
    body: z.object({
      id: z.string(),
      type: z.string(),
      data: z.record(z.string(), z.unknown()),
      tags: z.array(z.string()).optional(),
    }),
    parent: z.string().nullable(),
  }),
  z.object({
    kind: z.literal("template"),
    body: z.object({
      template_name: z.string(),
      root_id: z.string(),
      vars: z.record(z.string(), z.string()),
    }),
    root_type: z.string(),
  }),
]);
type Command = z.infer<typeof Command>;

export interface TaskCreatePrefill {
  type?: string;
  fields?: Record<string, unknown>;
  parent?: string;
}

function initialValue(prefill?: TaskCreatePrefill): DraftValue {
  return {
    mode: "blank",
    type: prefill?.type ?? "",
    id: newTaskId(),
    fields: {},
    parent: prefill?.parent ?? "",
    tags: "",
    template: "",
    root_id: newTaskId(),
    vars: {},
  };
}

function sameData(
  sent: Record<string, unknown>,
  stored: Record<string, unknown>,
): boolean {
  return Object.entries(sent).every(
    ([key, value]) => JSON.stringify(stored[key]) === JSON.stringify(value),
  );
}

/**
 * Send a frozen create command. Only a retry of a command that was already
 * sent may find its own task in place (the first response was lost); then a
 * task matching what this command sent means the earlier send succeeded. On a
 * first send, "already exists" is always someone else's task.
 */
async function sendCreate(
  projectId: string,
  command: Command,
  key: string,
  retry: boolean,
): Promise<{ id: string; linkError?: string }> {
  if (command.kind === "template") {
    try {
      await instantiateTemplate(projectId, command.body, key);
    } catch (error) {
      if (!retry || failureKind(error) !== "exists") throw error;
      const root = await getTaskDetail(projectId, command.body.root_id);
      if (root.entity.type !== command.root_type) throw error;
    }
    return { id: command.body.root_id };
  }
  try {
    await createTask(projectId, command.body, key);
  } catch (error) {
    if (!retry || failureKind(error) !== "exists") throw error;
    const existing = await getTaskDetail(projectId, command.body.id);
    if (
      existing.entity.type !== command.body.type ||
      !sameData(command.body.data, existing.entity.data) ||
      [...(existing.entity.tags ?? [])].sort().join("\n") !==
        [...(command.body.tags ?? [])].sort().join("\n")
    )
      throw error;
  }
  if (command.parent) {
    try {
      // Idempotent: an existing edge answers `created: false`.
      await createTaskRelationship(projectId, {
        from_id: command.parent,
        to_id: command.body.id,
        type: "parent-child",
      });
    } catch (error) {
      return { id: command.body.id, linkError: failureMessage(error) };
    }
  }
  return { id: command.body.id };
}

interface TaskCreateDrawerProps {
  /** Overrides the default close (dropping `create` from the URL). */
  onClose?: () => void;
  prefill?: TaskCreatePrefill;
  /** Draft scope; follow-ups use their own so drafts never mix. */
  scope?: string;
  /** Called after the task exists, before navigating to it. */
  /**
   * Checked before a new submission is frozen; return a message to block it.
   * Not called when retrying an already frozen request.
   */
  validate?: () => string | null;
  /**
   * Runs after the task exists, inside the same retryable submission. It must
   * be idempotent: a retry replays it after recognising the existing task.
   */
  afterCreate?: (id: string) => Promise<void>;
  title?: string;
  children?: ReactNode;
}

export function TaskCreateDrawer({
  onClose,
  prefill,
  scope = "new",
  validate,
  afterCreate,
  title = "New task",
  children,
}: TaskCreateDrawerProps) {
  const { projectId } = useAuth();
  const project = projectId ?? "";
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const client = useQueryClient();
  const whoami = useWhoami();
  const allowed = rights(whoami.data, project);
  const catalog = useWorkCatalog();
  const templates = useQuery({
    queryKey: ["templates", project],
    queryFn: () => listTemplates(project),
    enabled: Boolean(projectId),
    staleTime: 30_000,
  });
  const { draft, update, discard } = useOperationDraft<DraftValue, Command>(
    whoami.data?.principal_id
      ? operationKey("task-create", whoami.data.principal_id, project, scope)
      : null,
    () => initialValue(prefill),
    { value: DraftValue, command: Command },
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [linkError, setLinkError] = useState<string | null>(null);
  const value = draft.value;
  const set = (patch: Partial<DraftValue>) =>
    update((d) => editOperation(d, { ...d.value, ...patch }));

  const declared = (catalog.data?.types ?? []).filter(
    (entry): entry is WorkCatalogEntry & { definition: object } =>
      entry.declaration === "declared" && Boolean(entry.definition),
  );
  const creatable = declared.filter((entry) => allowed.createTask(entry.type));
  const entry = creatable.find((e) => e.type === value.type);
  const fields: CatalogField[] = entry?.definition?.fields ?? [];
  const usable = (templates.data?.templates ?? []).filter((t) =>
    allowed.instantiate(t.entity_types),
  );
  const template = usable.find((t) => t.name === value.template);

  // Field inputs start from declared defaults (or a follow-up's prefill) the
  // first time a type is chosen; switching types keeps earlier inputs.
  // A new task starts in its first dispatchable state unless a default says otherwise.
  const lifecycle = entry?.definition?.lifecycle;
  const startState =
    lifecycle &&
    fields.some((f) => f.name === lifecycle.field && f.default === undefined)
      ? { [lifecycle.field]: lifecycle.dispatchable[0] ?? "" }
      : {};
  const fieldValues: RawFields = {
    ...rawFields(fields, null),
    ...startState,
    ...(prefill?.type === value.type && prefill.fields
      ? rawFields(
          fields.filter((f) => prefill.fields?.[f.name] !== undefined),
          prefill.fields,
        )
      : {}),
    ...value.fields,
  };

  const close =
    onClose ??
    (() => {
      const next = new URLSearchParams(searchParams);
      next.delete("create");
      setSearchParams(next);
    });

  const submit = useMutation({
    mutationFn: async ({
      staged,
      retry,
    }: {
      staged: NonNullable<typeof draft.pending>;
      retry: boolean;
    }) => {
      const result = await sendCreate(
        project,
        staged.command,
        staged.id,
        retry,
      );
      if (result.linkError || !afterCreate) return result;
      try {
        await afterCreate(result.id);
      } catch (error) {
        // Keep the server's status so the retry/conflict handling still applies.
        if (!(error instanceof ApiError)) throw error;
        throw new ApiError(
          error.code,
          `Task ${result.id} was created, but the follow-up step failed: ${error.message}. Retry finishes it without creating another task.`,
          error.details,
          error.status,
        );
      }
      return result;
    },
    onSuccess: async (result) => {
      await Promise.all([
        client.invalidateQueries({ queryKey: ["task-page", project] }),
        client.invalidateQueries({ queryKey: ["tasks", project] }),
        client.invalidateQueries({ queryKey: ["work-catalog", project] }),
      ]);
      if (result.linkError) {
        // The task exists; only the parent link is missing. Keep the frozen
        // command so "Retry" re-links without creating anything twice.
        setLinkError(result.linkError);
        return;
      }
      discard();
      navigate(`/p/${project}/tasks/${encodeURIComponent(result.id)}`);
    },
    onError: (error) => {
      const kind = failureKind(error);
      if (kind === "forbidden")
        void client.invalidateQueries({ queryKey: ["whoami", project] });
      // Anything the server definitely refused unfreezes the command so the
      // corrected input is sent with a new key.
      if (kind !== "unconfirmed") update(releaseOperation);
    },
  });

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (draft.pending) {
      // A frozen command was sent before; its outcome is unknown.
      submit.mutate({ staged: draft.pending, retry: true });
      return;
    }
    setLinkError(null);
    let next = draft;
    if (value.mode === "blank") {
      if (!entry) return setErrors({ type: "Choose a type." });
      if (!value.id.trim()) return setErrors({ id: "Enter an ID." });
      const converted = fromRaw(fields, fieldValues);
      if (!converted.ok) return setErrors(converted.errors);
      const parent = value.parent.trim();
      const tags = value.tags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      next = stageOperation(draft, () => ({
        kind: "task",
        body: {
          id: value.id.trim(),
          type: entry.type,
          data: parent
            ? { ...converted.data, parent_id: parent }
            : converted.data,
          ...(tags.length ? { tags } : {}),
        },
        parent: parent || null,
      }));
    } else {
      if (!template) return setErrors({ template: "Choose a template." });
      if (!value.root_id.trim()) return setErrors({ root_id: "Enter an ID." });
      const missing = template.variables.filter(
        (name) => !(value.vars[name] ?? "").trim(),
      );
      if (missing.length)
        return setErrors(
          Object.fromEntries(
            missing.map((name) => [`var:${name}`, "Required."]),
          ),
        );
      next = stageOperation(draft, () => ({
        kind: "template",
        body: {
          template_name: template.name,
          root_id: value.root_id.trim(),
          vars: Object.fromEntries(
            template.variables.map((name) => [name, value.vars[name].trim()]),
          ),
        },
        root_type: template.entities[0]?.type ?? "",
      }));
    }
    // The caller's own checks run last, so they only freeze their part once
    // this form is valid too.
    const blocked = validate?.();
    if (blocked) return setErrors({ form: blocked });
    setErrors({});
    update(() => next);
    if (next.pending) submit.mutate({ staged: next.pending, retry: false });
  }

  const kind = submit.isError ? failureKind(submit.error) : null;
  const busy = submit.isPending;
  // While a request is unconfirmed its command is frozen: inputs lock so the
  // retry cannot silently drop edits made after sending.
  const locked = busy || Boolean(draft.pending);

  return (
    <Drawer title={title} onClose={close}>
      <form className="space-y-6 p-6" onSubmit={onSubmit} noValidate>
        {children}
        {!allowed.edit && whoami.data && (
          <FormNotice tone="info">
            This credential cannot create tasks. Ask a project maintainer for
            participant access with task write permission.
          </FormNotice>
        )}
        {usable.length > 0 && (
          <fieldset className="flex flex-wrap gap-2" disabled={locked}>
            <legend className="sr-only">Start from</legend>
            {(["blank", "template"] as const).map((mode) => (
              <label
                key={mode}
                className="flex cursor-pointer items-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm has-[:checked]:border-signal-blue has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-signal-blue"
              >
                <input
                  type="radio"
                  name="mode"
                  value={mode}
                  className="sr-only"
                  checked={value.mode === mode}
                  onChange={() => set({ mode })}
                />
                {mode === "blank" ? "Blank task" : "From template"}
              </label>
            ))}
          </fieldset>
        )}

        {value.mode === "blank" ? (
          <div className="grid gap-4">
            {(!catalog.data && !catalog.isError) ||
            (!whoami.data && !whoami.isError) ? (
              <p className="text-sm text-muted-foreground">
                Loading task types…
              </p>
            ) : catalog.isError && !catalog.data ? (
              <FormNotice>
                Task types could not be loaded. Retry, or check the project
                definitions.
              </FormNotice>
            ) : creatable.length === 0 && catalog.data ? (
              <FormNotice tone="info">
                No declared task type can be created with this credential. Types
                that are not in the current schema cannot get new tasks.
              </FormNotice>
            ) : (
              <SelectField
                label="Type"
                required
                value={value.type}
                error={errors.type}
                disabled={locked}
                placeholder="Choose…"
                options={creatable.map((e) => ({ value: e.type }))}
                onChange={(e) => set({ type: e.target.value })}
              />
            )}
            {entry && (
              <SchemaForm
                fields={fields}
                values={fieldValues}
                errors={errors}
                disabled={locked}
                roles={presentationRoles(entry.definition?.presentation)}
                onChange={(name, v) =>
                  set({ fields: { ...value.fields, [name]: v } })
                }
              />
            )}
            <TextField
              label="Parent task ID"
              hint="Optional. Also adds a parent-child relationship."
              value={value.parent}
              disabled={locked}
              onChange={(e) => set({ parent: e.target.value })}
            />
            <TextField
              label="Tags"
              hint="Comma separated."
              value={value.tags}
              disabled={locked}
              onChange={(e) => set({ tags: e.target.value })}
            />
            <details>
              <summary className="cursor-pointer text-xs text-muted-foreground">
                Advanced
              </summary>
              <div className="mt-3">
                <TextField
                  label="Task ID"
                  required
                  className="font-mono"
                  value={value.id}
                  error={errors.id}
                  disabled={locked}
                  onChange={(e) => set({ id: e.target.value })}
                />
              </div>
            </details>
          </div>
        ) : (
          <div className="grid gap-4">
            <SelectField
              label="Template"
              required
              value={value.template}
              error={errors.template}
              disabled={locked}
              placeholder="Choose…"
              options={usable.map((t) => ({
                value: t.name,
                label: t.description ? `${t.name} — ${t.description}` : t.name,
              }))}
              onChange={(e) => set({ template: e.target.value })}
            />
            {template?.variables.map((name) => (
              <TextField
                key={name}
                label={<span className="font-mono">{name}</span>}
                required
                value={value.vars[name] ?? ""}
                error={errors[`var:${name}`]}
                disabled={locked}
                onChange={(e) =>
                  set({ vars: { ...value.vars, [name]: e.target.value } })
                }
              />
            ))}
            <TextField
              label="Root task ID"
              required
              hint="Each template task gets this ID plus its suffix."
              className="font-mono"
              value={value.root_id}
              error={errors.root_id}
              disabled={locked}
              onChange={(e) => set({ root_id: e.target.value })}
            />
            {template && (
              <div>
                <p className="tila-label">Creates</p>
                <ul className="mt-2 space-y-1 text-sm">
                  {template.entities.map((e) => (
                    <li key={e.key} className="flex gap-2">
                      <span className="font-mono text-foreground">
                        {value.root_id.trim() + e.id_suffix}
                      </span>
                      <span className="text-muted-foreground">{e.type}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        {errors.form && <FormNotice>{errors.form}</FormNotice>}
        {kind === "unconfirmed" && (
          <FormNotice tone="warning">
            The server did not confirm this request (
            {failureMessage(submit.error)}
            ). It may already have been applied. Retry sends the same request,
            so it cannot create a second task.
          </FormNotice>
        )}
        {kind === "exists" && (
          <FormNotice>
            {value.mode === "template"
              ? "A task with one of these IDs already exists. Change the root task ID and create again."
              : "A different task already uses this ID. Change the ID under Advanced and create again."}
          </FormNotice>
        )}
        {(kind === "invalid" || kind === "conflict") && (
          <FormNotice>
            {failureMessage(submit.error)} Your input is kept.
          </FormNotice>
        )}
        {kind === "forbidden" && (
          <FormNotice>
            Your access changed and this request was refused. Your input is
            kept.
          </FormNotice>
        )}
        {linkError && (
          <FormNotice tone="warning">
            The task was created, but linking the parent failed: {linkError}.
            Retry links it without creating another task.
          </FormNotice>
        )}

        <div className="flex flex-wrap justify-end gap-2">
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
          <Button type="submit" disabled={busy || !allowed.edit}>
            {busy
              ? "Creating…"
              : draft.pending
                ? "Retry"
                : value.mode === "template"
                  ? "Create from template"
                  : "Create task"}
          </Button>
        </div>
      </form>
    </Drawer>
  );
}
