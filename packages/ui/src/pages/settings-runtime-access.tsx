import { CheckboxField } from "@/components/definitions/controls";
import {
  PolicyFields,
  formToPolicy,
  policySummary,
  presetForm,
} from "@/components/settings/policy-fields";
import { SecretReveal } from "@/components/settings/secret-reveal";
import {
  ManageNote,
  OwnerStepUp,
  SettingsHeading,
  WriteFailure,
} from "@/components/settings/settings-ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { Drawer } from "@/components/ui/drawer";
import { FormNotice, TextField } from "@/components/ui/form-fields";
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
  useInvalidateAccess,
  useRuntimeEnrollments,
  useRuntimeInvitations,
  useStepUp,
} from "@/hooks/use-access-settings";
import {
  isStepUpRequired,
  useAdminCapabilities,
  useWhoami,
} from "@/hooks/use-admin";
import { useSecretRequest } from "@/hooks/use-secret-request";
import {
  createRuntimeInvitation,
  revokeRuntimeEnrollment,
  revokeRuntimeInvitation,
} from "@/lib/api";
import { failureKind, failureMessage } from "@/lib/mutation-errors";
import { deriveSectionState } from "@/lib/query-state";
import { formatDateTime } from "@/lib/time";
import { useMutation } from "@tanstack/react-query";
import type { RuntimeEnrollment, RuntimeInvitation } from "@tila/schemas";
import { type FormEvent, useState } from "react";

/** Runtime timestamps are epoch seconds. */
const toMs = (value: number) => (value < 1e12 ? value * 1000 : value);
const HUMAN = /^(github|oidc):/;

const INVITATION_BADGE: Record<
  RuntimeInvitation["state"],
  "green" | "gray" | "red"
> = { pending: "green", expired: "gray", revoked: "red" };

/** An invitation secret held only in page state until dismissed. */
type Revealed = { name: string; secret: string; expiresAt: number };

export function SettingsRuntimeAccessPage() {
  const { canManageRuntimeAccess } = useAdminCapabilities();
  const whoami = useWhoami();
  const me = whoami.data?.principal_id;
  const enrollments = useRuntimeEnrollments();
  const invitations = useRuntimeInvitations(canManageRuntimeAccess);
  const stepUp = useStepUp();
  const [creating, setCreating] = useState(false);
  const [revealed, setRevealed] = useState<Revealed | null>(null);
  const [revokingEnrollment, setRevokingEnrollment] = useState<string | null>(
    null,
  );
  const [revokingInvitation, setRevokingInvitation] = useState<string | null>(
    null,
  );
  const [notice, setNotice] = useState<string | null>(null);
  // Sponsors revoke their own installations only with a GitHub or OIDC
  // sign-in; owners may revoke any installation.
  const mayRevoke = (row: RuntimeEnrollment) =>
    row.revoked_at === null &&
    (canManageRuntimeAccess ||
      (row.sponsor_id !== null &&
        row.sponsor_id === me &&
        HUMAN.test(me ?? "")));
  const enrollment = enrollments.data?.find(
    (row) => row.enrollment_id === revokingEnrollment,
  );
  const invitation = invitations.data?.find(
    (row) => row.invitation_id === revokingInvitation,
  );

  return (
    <div className="space-y-8 p-3 md:p-6">
      <SettingsHeading title="Runtime access">
        Machines and CI runners enrolled to run agents for this project. An
        installation enrolls from the machine itself with{" "}
        <code className="font-mono">tila machine enroll</code>, because
        enrollment needs a key that never leaves that machine; this page reviews
        and revokes installations and shares invitations.
      </SettingsHeading>
      {stepUp.required && <OwnerStepUp onDismiss={stepUp.dismiss} />}
      {revealed && (
        <SecretReveal
          title={`Invitation for ${revealed.name}`}
          secret={revealed.secret}
          onDismiss={() => setRevealed(null)}
        >
          <p>
            Redeem it on the machine before{" "}
            {formatDateTime(toMs(revealed.expiresAt))}: run{" "}
            <code className="font-mono">
              tila machine enroll --invitation-stdin
            </code>{" "}
            and paste it. One invitation enrolls one installation.
          </p>
        </SecretReveal>
      )}
      {notice && <FormNotice tone="info">{notice}</FormNotice>}

      <section aria-labelledby="installations-heading" className="space-y-3">
        <h2
          id="installations-heading"
          className="font-logo text-lg tracking-tight"
        >
          Installations
        </h2>
        {!canManageRuntimeAccess && (
          <ManageNote>
            You see the installations you sponsor; owners see all of them.
            {me?.startsWith("user:") &&
              " Revoking your own installation needs a GitHub or OIDC sign-in; with an email account, ask a project owner."}
          </ManageNote>
        )}
        <QuerySection
          state={deriveSectionState(enrollments)}
          label="installations"
          empty={
            canManageRuntimeAccess
              ? "No installations are enrolled."
              : "You sponsor no installations."
          }
          onRetry={() => void enrollments.refetch()}
        >
          {(rows) => (
            <div className="overflow-x-auto rounded-lg border border-border">
              <Table aria-label="Installations">
                <TableHeader>
                  <TableRow>
                    <TableHead>Installation</TableHead>
                    <TableHead>Kind</TableHead>
                    <TableHead>Sponsor</TableHead>
                    <TableHead>Enrolled</TableHead>
                    <TableHead>State</TableHead>
                    <TableHead>
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row) => (
                    <TableRow
                      key={row.enrollment_id}
                      className={row.revoked_at === null ? "" : "opacity-60"}
                    >
                      <TableCell>
                        <div className="font-sans text-fg-strong">
                          {row.name}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {row.principal_id}
                        </div>
                      </TableCell>
                      <TableCell className="text-xs">{row.kind}</TableCell>
                      <TableCell className="text-xs">
                        {row.sponsor_id ?? "invitation"}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {formatDateTime(toMs(row.created_at))}
                      </TableCell>
                      <TableCell>
                        {row.revoked_at === null ? (
                          <Badge variant="green">active</Badge>
                        ) : (
                          <Badge variant="red">revoked</Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        {mayRevoke(row) && (
                          <Button
                            type="button"
                            size="xs"
                            variant="ghost"
                            className="text-status-red"
                            aria-label={`Revoke ${row.name}`}
                            onClick={() => {
                              setNotice(null);
                              setRevokingEnrollment(row.enrollment_id);
                            }}
                          >
                            Revoke
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </QuerySection>
      </section>

      {canManageRuntimeAccess && (
        <section aria-labelledby="invitations-heading" className="space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <h2
              id="invitations-heading"
              className="font-logo text-lg tracking-tight"
            >
              Shared invitations
            </h2>
            <Button
              type="button"
              size="sm"
              className="ml-auto"
              onClick={() => {
                setNotice(null);
                setCreating(true);
              }}
            >
              Create invitation
            </Button>
          </div>
          <p className="text-sm text-muted-foreground">
            An invitation lets a shared machine, such as a CI runner, enroll
            without a personal sign-in. It expires after ten minutes; its secret
            is shown only when it is created.
          </p>
          <QuerySection
            state={deriveSectionState(invitations)}
            label="invitations"
            empty="No invitations."
            onRetry={() => void invitations.refetch()}
          >
            {(rows) => (
              <div className="overflow-x-auto rounded-lg border border-border">
                <Table aria-label="Invitations">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Invitation</TableHead>
                      <TableHead>State</TableHead>
                      <TableHead className="text-right">Enrolled</TableHead>
                      <TableHead>Expires</TableHead>
                      <TableHead>
                        <span className="sr-only">Actions</span>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((row) => (
                      <TableRow key={row.invitation_id}>
                        <TableCell>
                          <div className="font-sans text-fg-strong">
                            {row.name}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {policySummary(row.policy)} · by {row.created_by}
                          </div>
                        </TableCell>
                        <TableCell>
                          <Badge variant={INVITATION_BADGE[row.state]}>
                            {row.state}
                          </Badge>
                        </TableCell>
                        <TableCell className="tila-num text-right">
                          {row.enrollments}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {formatDateTime(toMs(row.expires_at))}
                        </TableCell>
                        <TableCell className="text-right">
                          {row.state === "pending" && (
                            <Button
                              type="button"
                              size="xs"
                              variant="ghost"
                              className="text-status-red"
                              aria-label={`Revoke invitation ${row.name}`}
                              onClick={() => {
                                setNotice(null);
                                setRevokingInvitation(row.invitation_id);
                              }}
                            >
                              Revoke
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </QuerySection>
        </section>
      )}

      {creating && (
        <CreateInvitationDrawer
          onClose={() => setCreating(false)}
          onStepUp={stepUp.caught}
          onCreated={(next) => {
            setCreating(false);
            setRevealed(next);
          }}
        />
      )}
      {enrollment && (
        <RevokeEnrollmentDialog
          enrollment={enrollment}
          onClose={() => setRevokingEnrollment(null)}
          onStepUp={stepUp.caught}
          onRevoked={() => {
            setRevokingEnrollment(null);
            setNotice(
              `Revoked ${enrollment.name}. Its credentials stopped working and its agent bindings were released.`,
            );
          }}
        />
      )}
      {invitation && (
        <RevokeInvitationDialog
          invitation={invitation}
          onClose={() => setRevokingInvitation(null)}
          onStepUp={stepUp.caught}
          onRevoked={(revoked) => {
            setRevokingInvitation(null);
            setNotice(
              revoked
                ? `Revoked the invitation ${invitation.name}; it can no longer be redeemed.`
                : `The invitation ${invitation.name} was already revoked.`,
            );
          }}
        />
      )}
    </div>
  );
}

function CreateInvitationDrawer({
  onClose,
  onCreated,
  onStepUp,
}: {
  onClose: () => void;
  onCreated: (revealed: Revealed) => void;
  onStepUp: (error: unknown) => boolean;
}) {
  const { projectId } = useAdminCapabilities();
  const invalidate = useInvalidateAccess();
  const [name, setName] = useState("");
  const [custom, setCustom] = useState(false);
  const [policy, setPolicy] = useState(() => presetForm("worker"));
  const [submitted, setSubmitted] = useState(false);
  const built = formToPolicy(policy);
  // Not through the query client: its caches would keep the secret.
  const create = useSecretRequest(
    (body: Parameters<typeof createRuntimeInvitation>[1]) =>
      createRuntimeInvitation(projectId as string, body),
    {
      onDone: (result) => {
        void invalidate.runtime();
        onCreated({
          name: name.trim(),
          secret: result.invitation,
          expiresAt: result.expires_at,
        });
      },
      onError: (error) => {
        if (onStepUp(error)) return onClose();
        if (failureKind(error) === "unconfirmed") void invalidate.runtime();
      },
    },
  );
  const problem =
    name.trim() && name.trim().length <= 100
      ? undefined
      : "Enter a name of up to 100 characters.";

  function submit(event: FormEvent) {
    event.preventDefault();
    setSubmitted(true);
    if (problem || (custom && built.problem !== null) || create.pending) return;
    void create.run({
      name: name.trim(),
      ...(custom && built.problem === null ? { policy: built.policy } : {}),
    });
  }

  return (
    <Drawer title="Create invitation" onClose={onClose}>
      <form className="space-y-4 p-6" onSubmit={submit} noValidate>
        <TextField
          label="Installation name"
          required
          autoFocus
          value={name}
          disabled={create.pending}
          error={submitted ? problem : undefined}
          hint="Names the installation the invitation enrolls, e.g. ci-runner-1."
          onChange={(e) => setName(e.target.value)}
        />
        <CheckboxField
          label="Set a narrower policy"
          hint="By default the installation gets the worker preset, within your own runtime authority."
          checked={custom}
          disabled={create.pending}
          onChange={setCustom}
        />
        {custom && (
          <PolicyFields
            form={policy}
            disabled={create.pending}
            problem={submitted ? (built.problem ?? undefined) : undefined}
            onChange={setPolicy}
          />
        )}
        {create.error !== null &&
          !isStepUpRequired(create.error) &&
          (failureKind(create.error) === "unconfirmed" ? (
            <FormNotice tone="warning">
              The server did not confirm the invitation (
              {failureMessage(create.error)}). It was not retried. If a pending
              invitation named {name.trim()} appears in the list, its secret was
              never shown: revoke it and create a new one.
            </FormNotice>
          ) : (
            <WriteFailure error={create.error} action="invitation" />
          ))}
        <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-4">
          <Button
            type="button"
            variant="ghost"
            disabled={create.pending}
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={create.pending}>
            {create.pending ? "Creating…" : "Create invitation"}
          </Button>
        </div>
      </form>
    </Drawer>
  );
}

function RevokeEnrollmentDialog({
  enrollment,
  onClose,
  onRevoked,
  onStepUp,
}: {
  enrollment: RuntimeEnrollment;
  onClose: () => void;
  onRevoked: () => void;
  onStepUp: (error: unknown) => boolean;
}) {
  const { projectId } = useAdminCapabilities();
  const invalidate = useInvalidateAccess();
  const revoke = useMutation({
    networkMode: "always",
    mutationFn: () =>
      revokeRuntimeEnrollment(projectId as string, enrollment.enrollment_id),
    onSuccess: () => {
      void invalidate.runtime();
      onRevoked();
    },
    onError: (error) => {
      if (onStepUp(error)) onClose();
    },
  });
  return (
    <ConfirmAction
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={`Revoke installation ${enrollment.name}`}
      confirmText={enrollment.name}
      confirmLabel="Revoke installation"
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
        <div className="space-y-2">
          <p>
            Its enrollment and run credentials stop working now, agent bindings
            held by its sessions are released, and it cannot start new runs.
          </p>
          <p>
            To use the machine again, enroll it again with tila machine enroll.
          </p>
        </div>
      }
    />
  );
}

function RevokeInvitationDialog({
  invitation,
  onClose,
  onRevoked,
  onStepUp,
}: {
  invitation: RuntimeInvitation;
  onClose: () => void;
  onRevoked: (revoked: boolean) => void;
  onStepUp: (error: unknown) => boolean;
}) {
  const { projectId } = useAdminCapabilities();
  const invalidate = useInvalidateAccess();
  const revoke = useMutation({
    networkMode: "always",
    mutationFn: () =>
      revokeRuntimeInvitation(projectId as string, invitation.invitation_id),
    onSuccess: (result) => {
      void invalidate.runtime();
      onRevoked(result.revoked);
    },
    onError: (error) => {
      if (onStepUp(error)) onClose();
    },
  });
  return (
    <ConfirmAction
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={`Revoke invitation ${invitation.name}`}
      confirmLabel="Revoke invitation"
      pending={revoke.isPending}
      error={
        revoke.error && !isStepUpRequired(revoke.error)
          ? failureMessage(revoke.error)
          : null
      }
      onConfirm={() => revoke.mutate()}
      description={
        <p>
          The invitation can no longer be redeemed. Installations it already
          enrolled ({invitation.enrollments}) keep working until you revoke them
          under Installations.
        </p>
      }
    />
  );
}
