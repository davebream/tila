import {
  PolicyFields,
  type PolicyForm,
  formToPolicy,
  policySummary,
  policyToForm,
  presetForm,
} from "@/components/settings/policy-fields";
import { WriteFailure } from "@/components/settings/settings-ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { Drawer } from "@/components/ui/drawer";
import {
  FormNotice,
  SelectField,
  TextField,
} from "@/components/ui/form-fields";
import { QuerySection } from "@/components/ui/query-section";
import {
  useInvalidateAccess,
  useWorkloadBindings,
} from "@/hooks/use-access-settings";
import { isStepUpRequired } from "@/hooks/use-admin";
import { useAuth } from "@/hooks/use-auth";
import {
  ApiError,
  type ServiceAccount,
  type WorkloadBinding,
  createServiceAccount,
  createWorkloadBinding,
  renameServiceAccount,
  revokeWorkloadBinding,
  updateWorkloadBinding,
} from "@/lib/api";
import { failureKind, failureMessage } from "@/lib/mutation-errors";
import { deriveSectionState } from "@/lib/query-state";
import { useMutation } from "@tanstack/react-query";
import { GITHUB_ACTIONS_ISSUER } from "@tila/schemas";
import { type FormEvent, useState } from "react";

const NAME = /^[a-z0-9-]{1,64}$/;
const NAME_RULE = "Use 1–64 lowercase letters, digits or hyphens.";

/**
 * A failed write that has no receipt to replay: tell the user to look before
 * trying again, because the first attempt may have applied.
 */
export function UnreplayableFailure({
  error,
  action,
}: {
  error: unknown;
  action: string;
}) {
  if (!error || isStepUpRequired(error)) return null;
  if (failureKind(error) === "unconfirmed")
    return (
      <FormNotice tone="warning">
        The server did not confirm the {action} ({failureMessage(error)}). It
        may have been applied: check the list before trying again.
      </FormNotice>
    );
  if (error instanceof ApiError && error.code === "credential-conflict")
    return (
      <FormNotice>
        That name is already used, or the change would remove the last owner.
        Choose another name or check the list.
      </FormNotice>
    );
  return <WriteFailure error={error} action={action} />;
}

export function CreateServiceAccountDrawer({
  onClose,
  onCreated,
  onStepUp,
}: {
  onClose: () => void;
  onCreated: (account: ServiceAccount) => void;
  onStepUp: (error: unknown) => boolean;
}) {
  const { projectId } = useAuth();
  const invalidate = useInvalidateAccess();
  const [name, setName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [role, setRole] = useState<"viewer" | "participant" | "maintainer">(
    "viewer",
  );
  const [submitted, setSubmitted] = useState(false);
  const create = useMutation({
    networkMode: "always",
    mutationFn: () =>
      createServiceAccount(projectId as string, {
        name: name.trim(),
        display_name: displayName.trim(),
        role,
      }),
    onSuccess: (result) => {
      void invalidate.services();
      onCreated(result.service_account);
    },
    onError: (error) => {
      if (onStepUp(error)) onClose();
      else if (failureKind(error) === "unconfirmed") void invalidate.services();
    },
  });
  const problems = {
    name: NAME.test(name.trim()) ? undefined : NAME_RULE,
    displayName:
      displayName.trim() && displayName.trim().length <= 255
        ? undefined
        : "Enter a display name of up to 255 characters.",
  };
  const blocked = Object.values(problems).some(Boolean);

  function submit(event: FormEvent) {
    event.preventDefault();
    setSubmitted(true);
    if (!blocked) create.mutate();
  }

  return (
    <Drawer title="Create service account" onClose={onClose}>
      <form className="space-y-4 p-6" onSubmit={submit} noValidate>
        <p className="text-sm text-muted-foreground">
          A service account is a non-human principal with its own project
          membership. Issue it credentials in Settings › Credentials, or let a
          CI workload act as it through a workload binding.
        </p>
        <TextField
          label="Name"
          required
          autoFocus
          className="font-mono"
          spellCheck={false}
          value={name}
          disabled={create.isPending}
          error={submitted ? problems.name : undefined}
          hint="Permanent. Lowercase letters, digits and hyphens."
          onChange={(e) => setName(e.target.value)}
        />
        <TextField
          label="Display name"
          required
          value={displayName}
          disabled={create.isPending}
          error={submitted ? problems.displayName : undefined}
          onChange={(e) => setDisplayName(e.target.value)}
        />
        <SelectField
          label="Membership role"
          value={role}
          disabled={create.isPending}
          options={["viewer", "participant", "maintainer"].map((value) => ({
            value,
          }))}
          hint="The most any credential or workload of this account can do."
          onChange={(e) => setRole(e.target.value as typeof role)}
        />
        <UnreplayableFailure error={create.error} action="creation" />
        <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-4">
          <Button
            type="button"
            variant="ghost"
            disabled={create.isPending}
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={create.isPending}>
            {create.isPending ? "Creating…" : "Create service account"}
          </Button>
        </div>
      </form>
    </Drawer>
  );
}

export function RenameServiceAccountDrawer({
  account,
  onClose,
  onSaved,
  onStepUp,
}: {
  account: ServiceAccount;
  onClose: () => void;
  onSaved: (account: ServiceAccount) => void;
  onStepUp: (error: unknown) => boolean;
}) {
  const { projectId } = useAuth();
  const invalidate = useInvalidateAccess();
  const [displayName, setDisplayName] = useState(account.display_name);
  const rename = useMutation({
    networkMode: "always",
    mutationFn: () =>
      renameServiceAccount(
        projectId as string,
        account.principal_id,
        displayName.trim(),
      ),
    onSuccess: (result) => {
      void invalidate.services();
      onSaved(result.service_account);
    },
    onError: (error) => {
      if (onStepUp(error)) onClose();
    },
  });
  const problem =
    displayName.trim() && displayName.trim().length <= 255
      ? null
      : "Enter a display name of up to 255 characters.";
  const unchanged = displayName.trim() === account.display_name;

  return (
    <Drawer title={`Rename ${account.name}`} onClose={onClose}>
      <form
        className="space-y-4 p-6"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (!problem && !unchanged) rename.mutate();
        }}
      >
        <p className="text-sm text-muted-foreground">
          Display only: the name {account.name} and principal ID{" "}
          <span className="font-mono">{account.principal_id}</span> never
          change, so credentials and history keep working.
        </p>
        <TextField
          label="Display name"
          required
          value={displayName}
          disabled={rename.isPending}
          error={problem ?? undefined}
          onChange={(e) => setDisplayName(e.target.value)}
        />
        <UnreplayableFailure error={rename.error} action="rename" />
        <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-4">
          <Button
            type="button"
            variant="ghost"
            disabled={rename.isPending}
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={rename.isPending || Boolean(problem) || unchanged}
          >
            {rename.isPending ? "Saving…" : "Save name"}
          </Button>
        </div>
      </form>
    </Drawer>
  );
}

type BindingDraft = {
  name: string;
  provider: "github-actions" | "oidc";
  issuer: string;
  subject: string;
  policy: PolicyForm;
};

const NEW_BINDING: BindingDraft = {
  name: "",
  provider: "github-actions",
  issuer: GITHUB_ACTIONS_ISSUER,
  subject: "",
  policy: presetForm("read-only"),
};

/**
 * Workload bindings let an external workload (GitHub Actions or another OIDC
 * issuer) act as this service account under a policy of its own.
 */
export function WorkloadBindingsDrawer({
  account,
  canManage,
  onClose,
  onStepUp,
}: {
  account: ServiceAccount;
  canManage: boolean;
  onClose: () => void;
  onStepUp: (error: unknown) => boolean;
}) {
  const bindings = useWorkloadBindings(account.principal_id, true);
  const state = deriveSectionState(bindings);
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [revoking, setRevoking] = useState<WorkloadBinding | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const active = account.revoked_at === null;
  const stepUp = (error: unknown) => {
    if (!onStepUp(error)) return false;
    onClose();
    return true;
  };

  return (
    <Drawer
      title={`Workload bindings · ${account.display_name}`}
      onClose={onClose}
    >
      <div className="space-y-4 p-6">
        <p className="text-sm text-muted-foreground">
          A workload whose token matches the issuer and subject acts as{" "}
          <span className="font-mono">{account.name}</span> under the binding's
          policy, capped by the account's membership. Policy changes apply to
          the next token exchange.
        </p>
        {notice && <FormNotice tone="info">{notice}</FormNotice>}
        <QuerySection
          state={state}
          label="workload bindings"
          empty="No workload bindings."
          onRetry={() => void bindings.refetch()}
        >
          {(rows) => (
            <ul aria-label="Workload bindings" className="space-y-3">
              {rows.map((binding) => (
                <li
                  key={binding.binding_id}
                  className="space-y-2 rounded-md border border-border p-3"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-sm">{binding.name}</span>
                    <Badge variant="gray">{binding.provider}</Badge>
                    {binding.revoked_at !== null && (
                      <Badge variant="red">revoked</Badge>
                    )}
                  </div>
                  <div className="break-all font-mono text-xs text-muted-foreground">
                    {binding.issuer} · {binding.subject}
                  </div>
                  <div className="text-xs">{policySummary(binding.policy)}</div>
                  {canManage && active && binding.revoked_at === null && (
                    <div className="flex gap-1">
                      <Button
                        type="button"
                        size="xs"
                        variant="outline"
                        aria-label={`Edit policy of ${binding.name}`}
                        onClick={() => {
                          setNotice(null);
                          setEditing(binding.binding_id);
                        }}
                      >
                        Edit policy
                      </Button>
                      <Button
                        type="button"
                        size="xs"
                        variant="ghost"
                        className="text-status-red"
                        aria-label={`Revoke ${binding.name}`}
                        onClick={() => {
                          setNotice(null);
                          setRevoking(binding);
                        }}
                      >
                        Revoke
                      </Button>
                    </div>
                  )}
                  {editing === binding.binding_id && (
                    <BindingForm
                      account={account}
                      binding={binding}
                      onDone={(message) => {
                        setEditing(null);
                        setNotice(message);
                      }}
                      onStepUp={stepUp}
                    />
                  )}
                </li>
              ))}
            </ul>
          )}
        </QuerySection>
        {canManage &&
          active &&
          (editing === "new" ? (
            <BindingForm
              account={account}
              binding={null}
              onDone={(message) => {
                setEditing(null);
                setNotice(message);
              }}
              onStepUp={stepUp}
            />
          ) : (
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setNotice(null);
                setEditing("new");
              }}
            >
              Add workload binding
            </Button>
          ))}
        {!canManage && (
          <p className="text-sm text-muted-foreground">
            Only an owner with workload-bindings:manage can change bindings.
          </p>
        )}
      </div>
      {revoking && (
        <RevokeBindingDialog
          account={account}
          binding={revoking}
          onClose={() => setRevoking(null)}
          onRevoked={() => {
            setRevoking(null);
            setNotice(`Revoked ${revoking.name}.`);
          }}
          onStepUp={stepUp}
        />
      )}
    </Drawer>
  );
}

/** Create a binding, or (with `binding`) replace its policy. */
function BindingForm({
  account,
  binding,
  onDone,
  onStepUp,
}: {
  account: ServiceAccount;
  binding: WorkloadBinding | null;
  onDone: (message: string | null) => void;
  onStepUp: (error: unknown) => boolean;
}) {
  const { projectId } = useAuth();
  const invalidate = useInvalidateAccess();
  const [value, setValue] = useState<BindingDraft>(() =>
    binding
      ? {
          name: binding.name,
          provider: binding.provider,
          issuer: binding.issuer,
          subject: binding.subject,
          policy: policyToForm(binding.policy),
        }
      : NEW_BINDING,
  );
  const [submitted, setSubmitted] = useState(false);
  const built = formToPolicy(value.policy);
  const save = useMutation({
    networkMode: "always",
    mutationFn: async () => {
      if (built.problem !== null) throw new Error(built.problem);
      if (binding)
        await updateWorkloadBinding(
          projectId as string,
          account.principal_id,
          binding.binding_id,
          built.policy,
        );
      else
        await createWorkloadBinding(projectId as string, account.principal_id, {
          name: value.name.trim(),
          provider: value.provider,
          issuer: value.issuer.trim(),
          subject: value.subject.trim(),
          policy: built.policy,
        });
    },
    onSuccess: () => {
      void invalidate.services();
      onDone(
        binding
          ? `Saved the policy of ${binding.name}; it applies to the next token exchange.`
          : `Added ${value.name.trim()}.`,
      );
    },
    onError: (error) => {
      onStepUp(error);
    },
  });
  const problems = binding
    ? {}
    : {
        name: NAME.test(value.name.trim()) ? undefined : NAME_RULE,
        issuer: /^https?:\/\/\S+$/.test(value.issuer.trim())
          ? undefined
          : "Enter the issuer URL.",
        subject:
          value.subject.trim() && value.subject.trim().length <= 255
            ? undefined
            : "Enter the subject claim to match (up to 255 characters).",
      };
  const blocked =
    Object.values(problems).some(Boolean) || built.problem !== null;
  const shown: Record<string, string | undefined> = submitted ? problems : {};

  return (
    <form
      aria-label={
        binding ? `Policy of ${binding.name}` : "New workload binding"
      }
      className="space-y-3 rounded-md border border-border p-3"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        setSubmitted(true);
        if (!blocked) save.mutate();
      }}
    >
      {!binding && (
        <>
          <TextField
            label="Name"
            required
            className="font-mono"
            spellCheck={false}
            value={value.name}
            disabled={save.isPending}
            error={shown.name}
            onChange={(e) => setValue({ ...value, name: e.target.value })}
          />
          <SelectField
            label="Provider"
            value={value.provider}
            disabled={save.isPending}
            options={[
              { value: "github-actions", label: "GitHub Actions" },
              { value: "oidc", label: "Other OIDC issuer" },
            ]}
            onChange={(e) => {
              const provider = e.target.value as BindingDraft["provider"];
              setValue({
                ...value,
                provider,
                issuer:
                  provider === "github-actions"
                    ? GITHUB_ACTIONS_ISSUER
                    : value.issuer,
              });
            }}
          />
          <TextField
            label="Issuer"
            required
            className="font-mono"
            spellCheck={false}
            value={value.issuer}
            disabled={save.isPending}
            error={shown.issuer}
            onChange={(e) => setValue({ ...value, issuer: e.target.value })}
          />
          <TextField
            label="Subject"
            required
            className="font-mono"
            spellCheck={false}
            value={value.subject}
            disabled={save.isPending}
            error={shown.subject}
            hint="The token's sub claim, e.g. repo:acme/widgets:ref:refs/heads/main."
            onChange={(e) => setValue({ ...value, subject: e.target.value })}
          />
        </>
      )}
      <PolicyFields
        form={value.policy}
        disabled={save.isPending}
        problem={submitted ? (built.problem ?? undefined) : undefined}
        onChange={(policy) => setValue({ ...value, policy })}
      />
      <UnreplayableFailure
        error={save.error}
        action={binding ? "policy change" : "binding creation"}
      />
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={save.isPending}
          onClick={() => onDone(null)}
        >
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={save.isPending}>
          {save.isPending ? "Saving…" : binding ? "Save policy" : "Add binding"}
        </Button>
      </div>
    </form>
  );
}

function RevokeBindingDialog({
  account,
  binding,
  onClose,
  onRevoked,
  onStepUp,
}: {
  account: ServiceAccount;
  binding: WorkloadBinding;
  onClose: () => void;
  onRevoked: () => void;
  onStepUp: (error: unknown) => boolean;
}) {
  const { projectId } = useAuth();
  const invalidate = useInvalidateAccess();
  const revoke = useMutation({
    networkMode: "always",
    mutationFn: () =>
      revokeWorkloadBinding(
        projectId as string,
        account.principal_id,
        binding.binding_id,
      ),
    onSuccess: () => {
      void invalidate.services();
      onRevoked();
    },
    onError: (error) => {
      onStepUp(error);
    },
  });
  return (
    <ConfirmAction
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={`Revoke binding ${binding.name}`}
      confirmText={binding.name}
      confirmLabel="Revoke binding"
      pending={revoke.isPending}
      error={
        revoke.error && !isStepUpRequired(revoke.error)
          ? failureKind(revoke.error) === "unconfirmed"
            ? "The server did not confirm the revocation. Check the list; revoking twice is harmless."
            : failureMessage(revoke.error)
          : null
      }
      onConfirm={() => revoke.mutate()}
      description={
        <p>
          Tokens from {binding.subject} stop being exchanged for sessions, and
          agent bindings started through it are released. The binding's record
          stays, so past actions remain attributed. This cannot be undone.
        </p>
      }
    />
  );
}
