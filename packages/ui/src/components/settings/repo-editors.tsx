import {
  CheckboxField,
  EditorSection,
} from "@/components/definitions/controls";
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
  SelectField,
  TextAreaField,
  TextField,
} from "@/components/ui/form-fields";
import { useInvalidateAccess } from "@/hooks/use-access-settings";
import { isStepUpRequired } from "@/hooks/use-admin";
import {
  ApiError,
  type RepoTarget,
  registerRepo,
  setRepoAccessPolicy,
  setRepoOidcPolicy,
} from "@/lib/api";
import {
  failureKind,
  failureMessage,
  revisionConflict,
} from "@/lib/mutation-errors";
import { operationKey } from "@/lib/operation-draft";
import { type SettingsCopy, useSettingsDraft } from "@/lib/settings-draft";
import { useMutation } from "@tanstack/react-query";
import type { RepoAccessPolicy, RepoLink, RepoOidcPolicy } from "@tila/schemas";
import { type FormEvent, type ReactNode, useState } from "react";
import { z } from "zod";

export const repoName = (link: RepoLink) =>
  `${link.github_owner}/${link.github_repo}`;
export const repoTarget = (link: RepoLink): RepoTarget => ({
  host: link.github_host,
  repoId: link.github_repo_id,
});

const GITHUB_PERMISSIONS = [
  "read",
  "triage",
  "write",
  "maintain",
  "admin",
] as const;
const RANK = Object.fromEntries(GITHUB_PERMISSIONS.map((p, i) => [p, i]));
const TILA_PERMISSIONS = ["read", "write", "admin"] as const;
const ROLE_CAPS = ["viewer", "participant", "maintainer"] as const;

/** Unconfirmed writes here carry the reviewed revision, never a receipt. */
function Unconfirmed({ action }: { action: string }) {
  return (
    <FormNotice tone="warning">
      The server did not confirm the {action}. Retry sends the same request
      against the same revision, so it cannot overwrite another change; if the
      first one was applied, the retry reports it as changed.
    </FormNotice>
  );
}

/** A failed policy save, except step-up (shown by the page) and conflicts. */
function SaveFailure({ error, action }: { error: unknown; action: string }) {
  if (!error || isStepUpRequired(error)) return null;
  if (failureKind(error) === "unconfirmed")
    return <Unconfirmed action={action} />;
  return <WriteFailure error={error} action={action} />;
}

function PolicyDrawer<F extends Record<string, unknown>, C>({
  title,
  intro,
  link,
  revision,
  policyKind,
  form: initial,
  canonical,
  schema,
  labels,
  problems,
  build,
  save: send,
  principal,
  onClose,
  onSaved,
  onStepUp,
  children,
}: {
  title: string;
  intro: ReactNode;
  link: RepoLink;
  revision: number;
  policyKind: "access" | "oidc";
  form: F;
  canonical: (form: F) => Record<keyof F, unknown>;
  schema: z.ZodType<F>;
  labels: Record<keyof F, string>;
  problems: (form: F) => Partial<Record<keyof F, string>>;
  build: (copy: SettingsCopy<F>) => C;
  save: (command: C) => Promise<unknown>;
  principal: string | null;
  onClose: () => void;
  onSaved: () => void;
  onStepUp: (error: unknown) => boolean;
  children: (
    form: F,
    edit: (change: Partial<F>) => void,
    shown: Partial<Record<keyof F, string>>,
    disabled: boolean,
  ) => ReactNode;
}) {
  const invalidate = useInvalidateAccess();
  const draft = useSettingsDraft({
    key: operationKey(
      `repo-${policyKind}-policy`,
      principal,
      link.github_host,
      String(link.github_repo_id),
    ),
    current: { revision, form: initial },
    canonical,
    schemas: { form: schema, command: z.unknown() as z.ZodType<C> },
  });
  const [submitted, setSubmitted] = useState(false);
  const mutation = useMutation({
    networkMode: "always",
    mutationFn: (op: { id: string; command: C }) => send(op.command),
    onSuccess: () => {
      draft.discard();
      void invalidate.repos();
      onSaved();
    },
    onError: (error) => {
      const kind = failureKind(error);
      if (kind !== "unconfirmed") draft.release();
      if (onStepUp(error)) return onClose();
      if (kind === "forbidden") void invalidate.access();
      if (kind === "conflict") void invalidate.repos();
    },
  });
  const found = problems(draft.form);
  const blocked = Object.keys(found).length > 0;
  const conflict = revisionConflict(mutation.error);
  const locked = mutation.isPending || Boolean(draft.pending);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (draft.pending) return mutation.mutate(draft.pending);
    setSubmitted(true);
    if (blocked || !draft.dirty) return;
    const staged = draft.stage(build);
    if (staged) mutation.mutate(staged);
  }

  return (
    <Drawer title={title} onClose={onClose}>
      <form className="space-y-5 p-6" onSubmit={submit} noValidate>
        <Facts
          label="Repository"
          rows={[
            ["Repository", repoName(link)],
            ["Host", link.github_host],
            ["Repository ID", String(link.github_repo_id)],
            ["Policy revision", String(revision)],
          ]}
        />
        <p className="text-sm text-muted-foreground">{intro}</p>
        {draft.stale ? (
          <LandedNotice
            revision={revision}
            changed={draft.landed.map((field) => labels[field])}
            onKeepMine={() => {
              mutation.reset();
              draft.keepMine();
            }}
            onLoadLatest={() => {
              mutation.reset();
              draft.discard();
            }}
          />
        ) : (
          conflict && <LandedNotice revision={null} changed={[]} />
        )}
        {children(
          draft.form,
          (change) => draft.edit((f) => ({ ...f, ...change })),
          submitted ? found : {},
          locked,
        )}
        <SaveFailure error={mutation.error} action="policy change" />
        {submitted && blocked && (
          <p role="alert" className="text-sm text-status-red">
            Fix the highlighted inputs to save.
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-4">
          <Button
            type="button"
            variant="ghost"
            disabled={mutation.isPending}
            onClick={() => {
              draft.discard();
              onClose();
            }}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={mutation.isPending || (!draft.pending && !draft.dirty)}
          >
            {mutation.isPending
              ? "Saving…"
              : draft.pending
                ? "Retry save"
                : "Save policy"}
          </Button>
        </div>
      </form>
    </Drawer>
  );
}

const AccessForm = z.object({
  min_read_permission: z.enum(GITHUB_PERMISSIONS),
  min_write_permission: z.enum(GITHUB_PERMISSIONS),
  max_permission: z.enum(TILA_PERMISSIONS),
  membership_enabled: z.boolean(),
  membership_role_cap: z.enum(ROLE_CAPS),
});
type AccessForm = z.infer<typeof AccessForm>;

const ACCESS_LABELS: Record<keyof AccessForm, string> = {
  min_read_permission: "the read threshold",
  min_write_permission: "the write threshold",
  max_permission: "the highest permission",
  membership_enabled: "member mirroring",
  membership_role_cap: "the mirrored role cap",
};

/** Defaults the server applies to a newly registered repository. */
const REGISTERED_DEFAULTS: AccessForm = {
  min_read_permission: "write",
  min_write_permission: "write",
  max_permission: "write",
  membership_enabled: false,
  membership_role_cap: "participant",
};

/** Who reaches the project through this repository, and how far. */
export function AccessPolicyDrawer({
  link,
  principal,
  onClose,
  onSaved,
  onStepUp,
}: {
  link: RepoLink;
  principal: string | null;
  onClose: () => void;
  onSaved: () => void;
  onStepUp: (error: unknown) => boolean;
}) {
  const stored = link.access_policy;
  return (
    <PolicyDrawer<AccessForm, RepoAccessPolicy & { expected_revision: number }>
      title={`Access policy · ${repoName(link)}`}
      intro={
        <>
          {!stored &&
            "The stored policy is invalid, so the server's defaults are shown; saving writes a complete policy. "}
          GitHub sign-ins from collaborators of this repository are checked
          against these thresholds on every later access check. Explicit
          memberships are not changed.
        </>
      }
      link={link}
      revision={link.access_policy_revision}
      policyKind="access"
      form={stored ?? REGISTERED_DEFAULTS}
      canonical={(form) => form}
      schema={AccessForm}
      labels={ACCESS_LABELS}
      problems={(form) =>
        RANK[form.min_read_permission] > RANK[form.min_write_permission]
          ? {
              min_write_permission:
                "The write threshold must be at least the read threshold.",
            }
          : {}
      }
      build={(copy) => ({ ...copy.form, expected_revision: copy.revision })}
      save={(command) => setRepoAccessPolicy(repoTarget(link), command)}
      principal={principal}
      onClose={onClose}
      onSaved={onSaved}
      onStepUp={onStepUp}
    >
      {(form, edit, shown, disabled) => (
        <>
          <EditorSection
            title="GitHub permission thresholds"
            description="The repository permission a collaborator needs on GitHub."
          >
            <SelectField
              label="To read"
              value={form.min_read_permission}
              disabled={disabled}
              options={GITHUB_PERMISSIONS.map((value) => ({ value }))}
              onChange={(e) =>
                edit({
                  min_read_permission: e.target
                    .value as AccessForm["min_read_permission"],
                })
              }
            />
            <SelectField
              label="To write"
              value={form.min_write_permission}
              disabled={disabled}
              error={shown.min_write_permission}
              options={GITHUB_PERMISSIONS.map((value) => ({ value }))}
              onChange={(e) =>
                edit({
                  min_write_permission: e.target
                    .value as AccessForm["min_write_permission"],
                })
              }
            />
            <SelectField
              label="Highest tila permission"
              value={form.max_permission}
              disabled={disabled}
              hint="Caps what a sign-in through this repository can do, whatever the GitHub permission."
              options={TILA_PERMISSIONS.map((value) => ({ value }))}
              onChange={(e) =>
                edit({
                  max_permission: e.target
                    .value as AccessForm["max_permission"],
                })
              }
            />
          </EditorSection>
          <EditorSection
            title="Member mirroring"
            description="Used when the project's membership policy mirrors GitHub (Settings › Access). GitHub never grants owner."
          >
            <CheckboxField
              label="Mirror collaborators as members"
              checked={form.membership_enabled}
              disabled={disabled}
              onChange={(membership_enabled) => edit({ membership_enabled })}
            />
            <SelectField
              label="Highest mirrored role"
              value={form.membership_role_cap}
              disabled={disabled || !form.membership_enabled}
              options={ROLE_CAPS.map((value) => ({ value }))}
              onChange={(e) =>
                edit({
                  membership_role_cap: e.target
                    .value as AccessForm["membership_role_cap"],
                })
              }
            />
          </EditorSection>
        </>
      )}
    </PolicyDrawer>
  );
}

const OidcForm = z.object({
  enabled: z.boolean(),
  max_permission: z.enum(TILA_PERMISSIONS),
  subject_pattern: z.string(),
  allowed_events: z.string(),
  allowed_refs: z.string(),
  allowed_environments: z.string(),
  allowed_workflows: z.string(),
});
type OidcForm = z.infer<typeof OidcForm>;
type ListField =
  | "allowed_events"
  | "allowed_refs"
  | "allowed_environments"
  | "allowed_workflows";

const OIDC_LABELS: Record<keyof OidcForm, string> = {
  enabled: "whether exchange is enabled",
  max_permission: "the highest permission",
  subject_pattern: "the subject pattern",
  allowed_events: "the events",
  allowed_refs: "the refs",
  allowed_environments: "the environments",
  allowed_workflows: "the workflows",
};

const OIDC_LISTS: Array<{ field: ListField; label: string; hint: string }> = [
  {
    field: "allowed_events",
    label: "Events",
    hint: "Required when enabled, e.g. push or workflow_dispatch.",
  },
  {
    field: "allowed_refs",
    label: "Refs",
    hint: "e.g. refs/heads/main. With refs or environments listed, a run must match one of either.",
  },
  {
    field: "allowed_environments",
    label: "Environments",
    hint: "Deployment environment names, e.g. production.",
  },
  {
    field: "allowed_workflows",
    label: "Workflows",
    hint: "Full job workflow refs, e.g. acme/widgets/.github/workflows/deploy.yml@refs/heads/main. Empty allows any workflow.",
  },
];

function toOidcForm(policy: RepoOidcPolicy | null): OidcForm {
  return {
    enabled: policy?.enabled ?? false,
    max_permission: policy?.max_permission ?? "read",
    subject_pattern: policy?.subject_pattern ?? "",
    allowed_events: (policy?.allowed_events ?? []).join("\n"),
    allowed_refs: (policy?.allowed_refs ?? []).join("\n"),
    allowed_environments: (policy?.allowed_environments ?? []).join("\n"),
    allowed_workflows: (policy?.allowed_workflows ?? []).join("\n"),
  };
}

function oidcCanonical(form: OidcForm) {
  return {
    enabled: form.enabled,
    max_permission: form.max_permission,
    subject_pattern: form.subject_pattern.trim() || null,
    allowed_events: uniqueLines(form.allowed_events),
    allowed_refs: uniqueLines(form.allowed_refs),
    allowed_environments: uniqueLines(form.allowed_environments),
    allowed_workflows: uniqueLines(form.allowed_workflows),
  };
}

function oidcProblems(form: OidcForm): Partial<Record<keyof OidcForm, string>> {
  const policy = oidcCanonical(form);
  const found: Partial<Record<keyof OidcForm, string>> = {};
  if ((policy.subject_pattern?.length ?? 0) > 512)
    found.subject_pattern = "Use at most 512 characters.";
  for (const { field } of OIDC_LISTS) {
    if (policy[field].length > 50) found[field] = "List at most 50 values.";
    else if (policy[field].some((value) => value.length > 512))
      found[field] = "Each value has at most 512 characters.";
  }
  if (policy.enabled && policy.allowed_events.length === 0)
    found.allowed_events = "An enabled policy must allow at least one event.";
  return found;
}

/** Which GitHub Actions runs may exchange their OIDC token for a session. */
export function OidcPolicyDrawer({
  link,
  principal,
  onClose,
  onSaved,
  onStepUp,
}: {
  link: RepoLink;
  principal: string | null;
  onClose: () => void;
  onSaved: () => void;
  onStepUp: (error: unknown) => boolean;
}) {
  return (
    <PolicyDrawer<OidcForm, RepoOidcPolicy & { expected_revision: number }>
      title={`Actions OIDC · ${repoName(link)}`}
      intro={
        <>
          {!link.oidc_policy &&
            "The stored policy is invalid, so a disabled policy is shown; saving writes a complete one. "}
          GitHub Actions runs in this repository can exchange their OIDC token
          for a project session when every condition matches. The policy is read
          on every exchange.
          {link.github_host !== "github.com" &&
            " Exchange is currently accepted only for github.com repositories."}
        </>
      }
      link={link}
      revision={link.oidc_policy_revision}
      policyKind="oidc"
      form={toOidcForm(link.oidc_policy)}
      canonical={oidcCanonical}
      schema={OidcForm}
      labels={OIDC_LABELS}
      problems={oidcProblems}
      build={(copy) => ({
        ...oidcCanonical(copy.form),
        expected_revision: copy.revision,
      })}
      save={(command) => setRepoOidcPolicy(repoTarget(link), command)}
      principal={principal}
      onClose={onClose}
      onSaved={onSaved}
      onStepUp={onStepUp}
    >
      {(form, edit, shown, disabled) => (
        <>
          <CheckboxField
            label="Allow Actions runs to exchange tokens"
            checked={form.enabled}
            disabled={disabled}
            onChange={(enabled) => edit({ enabled })}
          />
          <SelectField
            label="Highest tila permission"
            value={form.max_permission}
            disabled={disabled}
            options={TILA_PERMISSIONS.map((value) => ({ value }))}
            onChange={(e) =>
              edit({
                max_permission: e.target.value as OidcForm["max_permission"],
              })
            }
          />
          <TextField
            label="Subject pattern"
            className="font-mono"
            spellCheck={false}
            value={form.subject_pattern}
            disabled={disabled}
            error={shown.subject_pattern}
            hint="Optional. Matched against the token's sub claim, e.g. repo:acme/widgets:ref:refs/heads/main."
            onChange={(e) => edit({ subject_pattern: e.target.value })}
          />
          {OIDC_LISTS.map(({ field, label, hint }) => (
            <TextAreaField
              key={field}
              label={label}
              rows={3}
              className="font-mono text-xs"
              spellCheck={false}
              value={form[field]}
              disabled={disabled}
              error={shown[field]}
              hint={`One per line. ${hint}`}
              onChange={(e) => edit({ [field]: e.target.value })}
            />
          ))}
        </>
      )}
    </PolicyDrawer>
  );
}

/** Link a repository; the server resolves its ID through GitHub. */
export function RegisterRepoDrawer({
  onClose,
  onRegistered,
  onStepUp,
}: {
  onClose: () => void;
  onRegistered: (fullName: string) => void;
  onStepUp: (error: unknown) => boolean;
}) {
  const invalidate = useInvalidateAccess();
  const [owner, setOwner] = useState("");
  const [repo, setRepo] = useState("");
  const [host, setHost] = useState("github.com");
  const [submitted, setSubmitted] = useState(false);
  const register = useMutation({
    networkMode: "always",
    mutationFn: () =>
      registerRepo({
        owner: owner.trim(),
        repo: repo.trim(),
        github_host: host.trim().toLowerCase(),
      }),
    onSuccess: (result) => {
      void invalidate.repos();
      onRegistered(result.full_name);
    },
    onError: (error) => {
      if (onStepUp(error)) onClose();
    },
  });
  const problems = {
    owner: owner.trim() ? undefined : "Enter the owner.",
    repo: repo.trim() ? undefined : "Enter the repository name.",
    host: /^[a-z0-9.-]{1,253}(?::\d{1,5})?$/.test(host.trim().toLowerCase())
      ? undefined
      : "Enter a host name, e.g. github.com.",
  };
  const blocked = Object.values(problems).some(Boolean);
  const code = register.error instanceof ApiError ? register.error.code : null;

  function submit(event: FormEvent) {
    event.preventDefault();
    setSubmitted(true);
    if (!blocked) register.mutate();
  }

  return (
    <Drawer title="Link repository" onClose={onClose}>
      <form className="space-y-4 p-6" onSubmit={submit} noValidate>
        <p className="text-sm text-muted-foreground">
          The repository starts with conservative defaults: GitHub write
          permission to read or write, at most tila write, and no member
          mirroring. Adjust its policies after linking.
        </p>
        <TextField
          label="Owner"
          required
          autoFocus
          className="font-mono"
          spellCheck={false}
          value={owner}
          disabled={register.isPending}
          error={submitted ? problems.owner : undefined}
          onChange={(e) => setOwner(e.target.value)}
        />
        <TextField
          label="Repository"
          required
          className="font-mono"
          spellCheck={false}
          value={repo}
          disabled={register.isPending}
          error={submitted ? problems.repo : undefined}
          onChange={(e) => setRepo(e.target.value)}
        />
        <TextField
          label="Host"
          required
          className="font-mono"
          spellCheck={false}
          value={host}
          disabled={register.isPending}
          error={submitted ? problems.host : undefined}
          hint="github.com, or a GitHub Enterprise Server host."
          onChange={(e) => setHost(e.target.value)}
        />
        {code === "repo-not-found" ? (
          <FormNotice>
            GitHub has no repository {owner.trim()}/{repo.trim()} that this
            project can see. Check the spelling, or install the project's GitHub
            App on it.
          </FormNotice>
        ) : code === "repo-access-denied" ? (
          <FormNotice>
            GitHub refused access to {owner.trim()}/{repo.trim()}. Install the
            project's GitHub App on the repository, then try again.
          </FormNotice>
        ) : code === "github-api-timeout" || code === "github-api-error" ? (
          <FormNotice tone="warning">
            GitHub did not answer in time ({failureMessage(register.error)}).
            Linking the same repository again is safe.
          </FormNotice>
        ) : (
          register.error &&
          !isStepUpRequired(register.error) && (
            <WriteFailure error={register.error} action="link" />
          )
        )}
        <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-4">
          <Button
            type="button"
            variant="ghost"
            disabled={register.isPending}
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={register.isPending}>
            {register.isPending ? "Linking…" : "Link repository"}
          </Button>
        </div>
      </form>
    </Drawer>
  );
}
