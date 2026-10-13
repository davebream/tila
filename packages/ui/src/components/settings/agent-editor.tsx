import { EditorSection } from "@/components/definitions/controls";
import {
  Facts,
  LandedNotice,
  WriteFailure,
  uniqueLines,
} from "@/components/settings/settings-ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Drawer } from "@/components/ui/drawer";
import {
  FormNotice,
  SelectField,
  TextAreaField,
  TextField,
} from "@/components/ui/form-fields";
import { useInvalidateSettings } from "@/hooks/use-identities";
import { useTimeTick } from "@/hooks/use-time-tick";
import {
  type AgentView,
  ApiError,
  registerAgent,
  updateAgent,
} from "@/lib/api";
import { BINDING_LABEL, deriveBindingView, leaseCountdown } from "@/lib/lease";
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
  type Agent,
  AgentIdSchema,
  type UpdateAgent,
  UpdateAgentSchema,
} from "@tila/schemas";
import { type FormEvent, useState } from "react";
import { Link } from "react-router";
import { z } from "zod";

const ProfileForm = z.object({
  mode: z.enum(["none", "profile"]),
  profile_id: z.string(),
  host_ref: z.string(),
  account_ref: z.string(),
});
const AgentForm = z.object({
  name: z.string(),
  /** Principal IDs, one per line. */
  grants: z.string(),
  profile: ProfileForm,
});
type AgentForm = z.infer<typeof AgentForm>;

const FIELD_LABELS: Record<keyof AgentForm, string> = {
  name: "the name",
  grants: "the binding grants",
  profile: "the profile selection",
};

const ID_RULE =
  "Use 1–64 lowercase letters, digits, dots, underscores or hyphens, starting with a letter or digit.";

function toForm(agent: Agent): AgentForm {
  const selection = agent.profile_selection;
  return {
    name: agent.name,
    grants: agent.bind_policy.map((grant) => grant.principal_id).join("\n"),
    profile: selection
      ? {
          mode: "profile",
          profile_id: selection.profile_id,
          host_ref: selection.host_ref ?? "",
          account_ref: selection.account_ref ?? "",
        }
      : { mode: "none", profile_id: "", host_ref: "", account_ref: "" },
  };
}

function canonical(form: AgentForm) {
  return {
    name: form.name.trim(),
    grants: uniqueLines(form.grants),
    profile:
      form.profile.mode === "none"
        ? null
        : {
            profile_id: form.profile.profile_id.trim(),
            host_ref: form.profile.host_ref.trim() || null,
            account_ref: form.profile.account_ref.trim() || null,
          },
  };
}

type Problems = Partial<
  Record<"id" | "name" | "grants" | "profile_id" | "ref", string>
>;

function policyProblems(name: string, grants: string): Problems {
  const found: Problems = {};
  const trimmed = name.trim();
  if (!trimmed) found.name = "Enter a name.";
  else if (trimmed.length > 100) found.name = "Use at most 100 characters.";
  const principals = uniqueLines(grants);
  if (principals.length > 100) found.grants = "List at most 100 principals.";
  else if (principals.some((p) => p.length > 256))
    found.grants = "Each principal ID has at most 256 characters.";
  return found;
}

function editProblems(form: AgentForm): Problems {
  const found = policyProblems(form.name, form.grants);
  const profile = canonical(form).profile;
  if (profile) {
    if (!AgentIdSchema.safeParse(profile.profile_id).success)
      found.profile_id = profile.profile_id
        ? ID_RULE
        : "Enter the profile ID, or choose no selection.";
    if (
      (profile.host_ref?.length ?? 0) > 256 ||
      (profile.account_ref?.length ?? 0) > 256
    )
      found.ref = "Use at most 256 characters.";
  }
  return found;
}

const json = (value: unknown) => JSON.stringify(value);

/** The PATCH for the fields the user changed, against the copy's revision. */
function buildUpdate(id: string, copy: SettingsCopy<AgentForm>): UpdateAgent {
  const next = canonical(copy.form);
  const base = canonical(copy.base);
  const body: UpdateAgent = { expected_revision: copy.revision };
  if (next.name !== base.name) body.name = next.name;
  if (json(next.grants) !== json(base.grants))
    body.bind_policy = next.grants.map((principal_id) => ({
      principal_id,
      agent_id: id,
    }));
  if (json(next.profile) !== json(base.profile))
    body.profile_selection = next.profile;
  return body;
}

const GRANTS_HINT =
  "One principal ID per line. The owner can always bind. Removing a principal takes effect at the current holder's next mailbox call; adding one takes effect at the next attach.";

/**
 * Edit one agent's configured identity and policy. The drawer edits a copy and
 * writes only on save, against the revision it opened on. The observed
 * binding is evidence from the running session and is never edited here.
 */
export function AgentEditor({
  project,
  principal,
  view,
  onClose,
  onSaved,
}: {
  project: string;
  principal: string | null;
  view: AgentView;
  onClose: () => void;
  onSaved: (agent: Agent) => void;
}) {
  const { agent } = view;
  const invalidate = useInvalidateSettings();
  const draft = useSettingsDraft({
    key: operationKey("agent-settings", principal, project, agent.id),
    current: { revision: agent.revision, form: toForm(agent) },
    canonical,
    schemas: { form: AgentForm, command: UpdateAgentSchema },
  });
  const [submitted, setSubmitted] = useState(false);
  const save = useMutation({
    networkMode: "always",
    mutationFn: (op: { id: string; command: UpdateAgent }) =>
      updateAgent(project, agent.id, op.command, op.id),
    onSuccess: (result) => {
      draft.discard();
      void invalidate.agents();
      onSaved(result.agent);
    },
    onError: (error) => {
      const kind = failureKind(error);
      if (kind === "forbidden") void invalidate.access();
      if (kind !== "unconfirmed") draft.release();
      if (kind === "conflict") void invalidate.agents();
    },
  });

  const form = draft.form;
  const problems = editProblems(form);
  const blocked = Object.keys(problems).length > 0;
  const conflict = revisionConflict(save.error);
  // A pre-#298 server reports no revision; conditional writes cannot succeed.
  const unrevisioned = agent.revision === 0;
  const readOnly = agent.archived || unrevisioned;
  const locked = save.isPending || Boolean(draft.pending) || readOnly;
  const show = (problem: string | undefined) =>
    submitted ? problem : undefined;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (draft.pending) return save.mutate(draft.pending);
    setSubmitted(true);
    if (blocked || !draft.dirty || readOnly) return;
    const staged = draft.stage((copy) => buildUpdate(agent.id, copy));
    if (staged) save.mutate(staged);
  }

  const setProfile = (change: Partial<AgentForm["profile"]>) =>
    draft.edit((f) => ({ ...f, profile: { ...f.profile, ...change } }));

  return (
    <Drawer title={`Agent ${agent.id}`} onClose={onClose}>
      <form className="space-y-6 p-6" onSubmit={submit} noValidate>
        <EditorSection
          title="Identity"
          description="Stable: the ID names the mailbox and every attribution, and never changes."
        >
          <Facts
            label="Identity"
            rows={[
              ["ID", agent.id],
              ["Owner", agent.owner_principal_id],
              ["Registered", formatDateTime(agent.created_at)],
              ["Revision", String(agent.revision)],
            ]}
          />
        </EditorSection>

        <EditorSection
          title="Configured policy"
          description="Saved together as the agent's next revision. Saving never changes the active binding."
        >
          {agent.archived && (
            <FormNotice tone="info">
              Archived agents cannot be edited. Unarchive it from the list
              first.
            </FormNotice>
          )}
          {unrevisioned && (
            <FormNotice tone="info">
              This server does not report agent revisions, so changes cannot be
              checked against concurrent edits. Update the server to edit agents
              here.
            </FormNotice>
          )}
          {draft.stale ? (
            <LandedNotice
              revision={agent.revision}
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
            error={show(problems.name)}
            hint="Display only: renaming changes no ID, mailbox or past attribution."
            onChange={(e) => {
              const name = e.target.value;
              draft.edit((f) => ({ ...f, name }));
            }}
          />
          <TextAreaField
            label="Binding grants"
            value={form.grants}
            disabled={locked}
            spellCheck={false}
            className="font-mono text-xs"
            error={show(problems.grants)}
            hint={GRANTS_HINT}
            onChange={(e) => {
              const grants = e.target.value;
              draft.edit((f) => ({ ...f, grants }));
            }}
          />
          <fieldset className="space-y-3">
            <legend className="text-sm font-medium">Profile selection</legend>
            <SelectField
              label="A new attach must report"
              value={form.profile.mode}
              disabled={locked}
              options={[
                { value: "none", label: "No selection (any profile)" },
                { value: "profile", label: "A specific host profile" },
              ]}
              onChange={(e) =>
                setProfile({ mode: e.target.value as "none" | "profile" })
              }
            />
            {form.profile.mode === "profile" && (
              <>
                <TextField
                  label="Profile ID"
                  required
                  className="font-mono"
                  spellCheck={false}
                  value={form.profile.profile_id}
                  disabled={locked}
                  error={show(problems.profile_id)}
                  onChange={(e) => setProfile({ profile_id: e.target.value })}
                />
                <TextField
                  label="Host (enrollment ID)"
                  className="font-mono"
                  spellCheck={false}
                  value={form.profile.host_ref}
                  disabled={locked}
                  error={show(problems.ref)}
                  hint="Optional. Only an attach from this enrolled host matches."
                  onChange={(e) => setProfile({ host_ref: e.target.value })}
                />
                <TextField
                  label="Account reference"
                  className="font-mono"
                  spellCheck={false}
                  value={form.profile.account_ref}
                  disabled={locked}
                  error={show(problems.ref)}
                  hint="Optional. A name the host reports for its account, never a credential."
                  onChange={(e) => setProfile({ account_ref: e.target.value })}
                />
              </>
            )}
            <p className="text-xs text-muted-foreground">
              Applies to the next new attach only. A running session keeps its
              current profile; an attach that reports another profile is
              refused.
            </p>
          </fieldset>
        </EditorSection>

        <EditorSection
          title="Observed binding"
          description="Evidence the running session reported. Read-only here."
        >
          <ObservedBinding project={project} view={view} />
        </EditorSection>

        <EditorSection title="Host profile">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            Change the host's local profile
            <Badge variant="gray">Unsupported</Badge>
          </div>
          <p className="text-xs text-muted-foreground">
            Not available: the host has no supported command for this yet.
            Changing the selection above affects the next attach only.
          </p>
        </EditorSection>

        {save.error instanceof ApiError &&
        save.error.code === "agent-archived" ? (
          <FormNotice>
            This agent was archived meanwhile; nothing was saved.
          </FormNotice>
        ) : (
          <WriteFailure error={save.error} action="save" />
        )}
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
              save.isPending || readOnly || (!draft.pending && !draft.dirty)
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

function ObservedBinding({
  project,
  view,
}: {
  project: string;
  view: AgentView;
}) {
  useTimeTick(5000);
  const { agent, binding } = view;
  const runtime = (
    <p className="text-xs text-muted-foreground">
      <Link
        className="text-signal-blue underline"
        to={`/p/${project}/runtime/${encodeURIComponent(agent.id)}`}
      >
        Open in Runtime
      </Link>{" "}
      to see the run and host, or to release the binding.
    </p>
  );
  if (!binding)
    return (
      <>
        <p className="text-sm text-muted-foreground">
          No active binding (epoch {agent.binding_epoch}). The next authorized
          attach becomes the occupant.
        </p>
        {runtime}
      </>
    );
  const now = Date.now();
  const observed = deriveBindingView(binding, now);
  const lease =
    observed.kind === "none"
      ? "—"
      : `${new Date(observed.expiresAtMs).toLocaleString()} (${observed.kind === "attached" ? "expires" : "expired"} ${leaseCountdown(observed.expiresAtMs, now)})`;
  const rows: Array<[string, string]> = [
    ["Epoch", String(binding.binding_epoch)],
    ["State", BINDING_LABEL[observed.kind]],
    ["Lease", lease],
    ["Wake mechanism", binding.mechanism],
  ];
  const full = "holder" in binding ? binding : null;
  if (full) {
    const profile = full.profile;
    rows.push(
      ["Holder run", full.holder.run_id],
      ["Host", full.host_ref ?? "—"],
      ["Harness", full.harness],
      [
        "Reported profile",
        profile
          ? `${profile.profile_id} (revision ${profile.profile_revision}) · ${profile.account_ref} · ${profile.verification}`
          : "None reported",
      ],
    );
  }
  const selected = agent.profile_selection?.profile_id;
  const reported = full?.profile?.profile_id;
  return (
    <>
      <Facts label="Observed binding" rows={rows} />
      {!full && (
        <p className="text-xs text-muted-foreground">
          Holder, host and profile evidence are hidden from your access.
        </p>
      )}
      {selected && reported && selected !== reported && (
        <p className="text-xs text-status-amber">
          The running session reports profile {reported}; the selection (
          {selected}) applies from its next attach.
        </p>
      )}
      {runtime}
    </>
  );
}

const RegisterValue = z.object({
  id: z.string(),
  name: z.string(),
  grants: z.string(),
});
const RegisterCommand = z.object({
  id: z.string(),
  name: z.string(),
  bind_policy: z.array(
    z.object({ principal_id: z.string(), agent_id: z.string() }),
  ),
});

/** Register a new agent identity; the caller becomes its owner. */
export function RegisterAgentDrawer({
  project,
  principal,
  onClose,
  onRegistered,
}: {
  project: string;
  principal: string | null;
  onClose: () => void;
  onRegistered: (agent: Agent) => void;
}) {
  const invalidate = useInvalidateSettings();
  const { draft, update, discard } = useOperationDraft(
    operationKey("agent-register", principal, project),
    () => ({ id: "", name: "", grants: "" }),
    { value: RegisterValue, command: RegisterCommand },
  );
  const [submitted, setSubmitted] = useState(false);
  const register = useMutation({
    networkMode: "always",
    mutationFn: (op: {
      id: string;
      command: z.infer<typeof RegisterCommand>;
    }) => registerAgent(project, op.command, op.id),
    onSuccess: (result) => {
      discard();
      void invalidate.agents();
      onRegistered(result.agent);
    },
    onError: (error) => {
      const kind = failureKind(error);
      if (kind === "forbidden") void invalidate.access();
      if (kind !== "unconfirmed") update(releaseOperation);
    },
  });
  const value = draft.value;
  const id = value.id.trim();
  const problems: Problems = {
    ...policyProblems(value.name, value.grants),
    ...(AgentIdSchema.safeParse(id).success
      ? {}
      : { id: id ? ID_RULE : "Enter an ID." }),
  };
  const blocked = Object.keys(problems).length > 0;
  const locked = register.isPending || Boolean(draft.pending);
  const show = (problem: string | undefined) =>
    submitted ? problem : undefined;
  const set = (change: Partial<typeof value>) =>
    update((d) => editOperation(d, { ...d.value, ...change }));
  const code =
    register.error instanceof ApiError ? register.error.code : undefined;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (draft.pending) return register.mutate(draft.pending);
    setSubmitted(true);
    if (blocked) return;
    const next = stageOperation(draft, (v) => ({
      id,
      name: v.name.trim(),
      bind_policy: uniqueLines(v.grants).map((principal_id) => ({
        principal_id,
        agent_id: id,
      })),
    }));
    update(() => next);
    if (next.pending) register.mutate(next.pending);
  }

  return (
    <Drawer title="Register agent" onClose={onClose}>
      <form className="space-y-4 p-6" onSubmit={submit} noValidate>
        <p className="text-sm text-muted-foreground">
          You become the owner and can always bind it. The ID is permanent: it
          names the mailbox and appears in every attribution.
        </p>
        <TextField
          label="ID"
          required
          autoFocus
          className="font-mono"
          spellCheck={false}
          value={value.id}
          disabled={locked}
          error={show(problems.id)}
          hint="Lowercase letters, digits, dots, underscores and hyphens."
          onChange={(e) => set({ id: e.target.value })}
        />
        <TextField
          label="Name"
          required
          value={value.name}
          disabled={locked}
          error={show(problems.name)}
          onChange={(e) => set({ name: e.target.value })}
        />
        <TextAreaField
          label="Binding grants"
          value={value.grants}
          disabled={locked}
          spellCheck={false}
          className="font-mono text-xs"
          error={show(problems.grants)}
          hint="One principal ID per line, besides you. Leave empty to keep binding to yourself."
          onChange={(e) => set({ grants: e.target.value })}
        />
        {code === "conflict" ? (
          <FormNotice>
            An agent with this ID already exists with other settings. Choose
            another ID, or edit the existing agent.
          </FormNotice>
        ) : code === "agent-archived" ? (
          <FormNotice>
            This ID belongs to an archived agent. Unarchive it from the list
            instead.
          </FormNotice>
        ) : (
          <WriteFailure error={register.error} action="registration" />
        )}
        {submitted && blocked && (
          <p role="alert" className="text-sm text-status-red">
            Fix the highlighted inputs to register.
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-4">
          <Button
            type="button"
            variant="ghost"
            disabled={register.isPending}
            onClick={() => {
              discard();
              onClose();
            }}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={register.isPending}>
            {register.isPending
              ? "Registering…"
              : draft.pending
                ? "Retry registration"
                : "Register agent"}
          </Button>
        </div>
      </form>
    </Drawer>
  );
}
