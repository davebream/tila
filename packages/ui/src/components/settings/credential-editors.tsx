import {
  PolicyFields,
  formToPolicy,
  presetForm,
} from "@/components/settings/policy-fields";
import { Facts, WriteFailure } from "@/components/settings/settings-ui";
import { Button } from "@/components/ui/button";
import { Drawer } from "@/components/ui/drawer";
import {
  FormNotice,
  SelectField,
  TextField,
} from "@/components/ui/form-fields";
import { isStepUpRequired } from "@/hooks/use-admin";
import { useSecretRequest } from "@/hooks/use-secret-request";
import {
  ApiError,
  type IssuedCredential,
  type ServiceAccount,
  issueCredential,
  rotateCredential,
} from "@/lib/api";
import { failureKind, failureMessage } from "@/lib/mutation-errors";
import type { TokenListItem } from "@tila/schemas";
import { type FormEvent, useState } from "react";
import { Link } from "react-router";

const NAME = /^[a-z0-9-]{1,64}$/;
const PRINCIPAL = /^service:[0-9a-f-]{36}$/;
const DAY = 86_400;

const EXPIRY = [
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
  { value: "365", label: "1 year" },
  { value: "never", label: "Never expires" },
];

export function IssueCredentialDrawer({
  project,
  accounts,
  accountsUnavailable,
  onClose,
  onIssued,
  onStepUp,
  onUnconfirmed,
}: {
  project: string;
  /** Active service accounts; empty when there are none or they are unknown. */
  accounts: ServiceAccount[];
  /** The account list could not be read: accept a typed principal ID. */
  accountsUnavailable: boolean;
  onClose: () => void;
  onIssued: (result: IssuedCredential, requested: number) => void;
  onStepUp: (error: unknown) => boolean;
  onUnconfirmed: () => void;
}) {
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [principal, setPrincipal] = useState(
    accounts.length === 1 ? accounts[0].principal_id : "",
  );
  const [expiry, setExpiry] = useState("90");
  const [policy, setPolicy] = useState(() => presetForm("read-only"));
  const [submitted, setSubmitted] = useState(false);
  const built = formToPolicy(policy);
  // Not through the query client: its caches would keep the secret.
  const issue = useSecretRequest(
    (body: Parameters<typeof issueCredential>[0]) => issueCredential(body),
    {
      onDone: (result) => onIssued(result, policy.capabilities.length),
      onError: (error) => {
        if (onStepUp(error)) return onClose();
        if (failureKind(error) === "unconfirmed") onUnconfirmed();
      },
    },
  );
  const problems = {
    name: NAME.test(name.trim())
      ? undefined
      : "Use 1–64 lowercase letters, digits or hyphens.",
    note: note.length > 256 ? "Use at most 256 characters." : undefined,
    principal: PRINCIPAL.test(principal.trim())
      ? undefined
      : accountsUnavailable
        ? "Enter a service principal ID (service:<uuid>)."
        : "Choose the service account this credential acts as.",
  };
  const blocked =
    Object.values(problems).some(Boolean) || built.problem !== null;
  const noAccounts = !accountsUnavailable && accounts.length === 0;
  const code = issue.error instanceof ApiError ? issue.error.code : null;

  function submit(event: FormEvent) {
    event.preventDefault();
    setSubmitted(true);
    if (blocked || built.problem !== null || issue.pending) return;
    void issue.run({
      name: name.trim(),
      ...(note.trim() ? { note: note.trim() } : {}),
      principal_id: principal.trim(),
      policy: built.policy,
      expires_at:
        expiry === "never"
          ? null
          : Math.floor(Date.now() / 1000) + Number(expiry) * DAY,
    });
  }

  return (
    <Drawer title="Issue credential" onClose={onClose}>
      <form className="space-y-4 p-6" onSubmit={submit} noValidate>
        <p className="text-sm text-muted-foreground">
          A credential acts as one service account. The server narrows its
          policy to the account's membership and to your own access, and refuses
          capabilities that cannot be delegated.
        </p>
        {noAccounts && (
          <FormNotice tone="info">
            There is no active service account yet.{" "}
            <Link
              className="underline"
              to={`/p/${project}/settings/service-identities`}
            >
              Create one in Settings › Service identities
            </Link>{" "}
            first.
          </FormNotice>
        )}
        <TextField
          label="Name"
          required
          autoFocus
          className="font-mono"
          spellCheck={false}
          value={name}
          disabled={issue.pending}
          error={submitted ? problems.name : undefined}
          hint="Lowercase letters, digits and hyphens; unique among active credentials."
          onChange={(e) => setName(e.target.value)}
        />
        {accountsUnavailable ? (
          <TextField
            label="Service principal ID"
            required
            className="font-mono"
            spellCheck={false}
            value={principal}
            disabled={issue.pending}
            error={submitted ? problems.principal : undefined}
            hint="The service account list could not be read; enter its principal ID."
            onChange={(e) => setPrincipal(e.target.value)}
          />
        ) : (
          <SelectField
            label="Service account"
            required
            value={principal}
            disabled={issue.pending || noAccounts}
            error={submitted ? problems.principal : undefined}
            placeholder="Choose an account"
            options={accounts.map((account) => ({
              value: account.principal_id,
              label: `${account.display_name} (${account.name})`,
            }))}
            onChange={(e) => setPrincipal(e.target.value)}
          />
        )}
        <PolicyFields
          form={policy}
          disabled={issue.pending}
          problem={submitted ? (built.problem ?? undefined) : undefined}
          onChange={setPolicy}
        />
        <SelectField
          label="Expires"
          value={expiry}
          disabled={issue.pending}
          options={EXPIRY}
          onChange={(e) => setExpiry(e.target.value)}
        />
        <TextField
          label="Note"
          value={note}
          disabled={issue.pending}
          error={submitted ? problems.note : undefined}
          hint="Optional. Where the credential is used, for whoever reviews it later."
          onChange={(e) => setNote(e.target.value)}
        />
        {issue.error !== null &&
          !isStepUpRequired(issue.error) &&
          (failureKind(issue.error) === "unconfirmed" ? (
            <FormNotice tone="warning">
              The server did not confirm the issue (
              {failureMessage(issue.error)}). It was not retried, because
              issuing again could create a second credential. Check the list: if{" "}
              {name.trim()} appears there, its secret was never shown, so revoke
              it and issue a new one.
            </FormNotice>
          ) : code === "credential-conflict" ? (
            <FormNotice>
              An active credential is already named {name.trim()}. Choose
              another name, or rotate the existing one.
            </FormNotice>
          ) : (
            <WriteFailure error={issue.error} action="issue" />
          ))}
        <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-4">
          <Button
            type="button"
            variant="ghost"
            disabled={issue.pending}
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={issue.pending || noAccounts}>
            {issue.pending ? "Issuing…" : "Issue credential"}
          </Button>
        </div>
      </form>
    </Drawer>
  );
}

const OVERLAP = [
  { value: "0", label: "Immediately" },
  { value: "300", label: "After 5 minutes" },
  { value: "3600", label: "After 1 hour" },
  { value: "86400", label: "After 24 hours" },
];

export function RotateCredentialDrawer({
  token,
  onClose,
  onRotated,
  onStepUp,
  onChanged,
}: {
  token: TokenListItem;
  onClose: () => void;
  onRotated: (result: IssuedCredential, overlapSeconds: number) => void;
  onStepUp: (error: unknown) => boolean;
  /** The list may be out of date (conflict or an unconfirmed rotation). */
  onChanged: () => void;
}) {
  const [overlap, setOverlap] = useState("0");
  const rotate = useSecretRequest(
    (overlapSeconds: number) =>
      rotateCredential(token.name, {
        expected_token_id: token.token_id as string,
        overlap_seconds: overlapSeconds,
      }),
    {
      onDone: (result) => onRotated(result, Number(overlap)),
      onError: (error) => {
        if (onStepUp(error)) return onClose();
        const kind = failureKind(error);
        if (kind === "unconfirmed" || kind === "conflict") onChanged();
      },
    },
  );
  const code = rotate.error instanceof ApiError ? rotate.error.code : null;

  return (
    <Drawer title={`Rotate ${token.name}`} onClose={onClose}>
      <form
        className="space-y-4 p-6"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (!rotate.pending) void rotate.run(Number(overlap));
        }}
      >
        <p className="text-sm text-muted-foreground">
          Rotation issues a new secret for the same credential, principal and
          policy. It only applies if the credential is still at the version
          listed below.
        </p>
        <Facts
          label="Credential"
          rows={[
            ["Name", token.name],
            ["Principal", token.principal_id ?? "—"],
            ["Current version", token.token_id ?? "—"],
            ["Versions", String(token.versions?.length ?? 1)],
          ]}
        />
        <SelectField
          label="Previous secret stops working"
          value={overlap}
          disabled={rotate.pending}
          options={OVERLAP}
          hint="An overlap lets running clients switch to the new secret before the old one retires."
          onChange={(e) => setOverlap(e.target.value)}
        />
        {rotate.error !== null &&
          !isStepUpRequired(rotate.error) &&
          (failureKind(rotate.error) === "unconfirmed" ? (
            <FormNotice tone="warning">
              The server did not confirm the rotation (
              {failureMessage(rotate.error)}), and a new secret is shown only
              once. The list is reloaded: if {token.name} now has another
              version, rotate again to get a secret you can see; otherwise the
              current secret still works.
            </FormNotice>
          ) : code === "credential-conflict" ? (
            <FormNotice>
              {token.name} changed since the list was loaded: it was rotated,
              revoked or is bound to a workload. The list is reloaded; check it
              before rotating again.
            </FormNotice>
          ) : (
            <WriteFailure error={rotate.error} action="rotation" />
          ))}
        <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-4">
          <Button
            type="button"
            variant="ghost"
            disabled={rotate.pending}
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={rotate.pending}>
            {rotate.pending ? "Rotating…" : "Rotate credential"}
          </Button>
        </div>
      </form>
    </Drawer>
  );
}
