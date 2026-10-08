import { CredentialsTable } from "@/components/admin/credentials-table";
import { GrantMemberForm } from "@/components/admin/grant-member-form";
import { MembersTable } from "@/components/admin/members-table";
import { MembershipEvents } from "@/components/admin/membership-events";
import { MirroredAccessPanel } from "@/components/admin/mirrored-access-panel";
import { StepUpBanner } from "@/components/admin/step-up-banner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { LastRefreshed } from "@/components/ui/last-refreshed";
import { TableError } from "@/components/ui/table-error";
import {
  isStepUpRequired,
  useAdminCapabilities,
  useGrantMembership,
  useMembershipEvents,
  useMembershipPolicy,
  useMembershipRepos,
  useMemberships,
  useRevokeMembership,
  useRevokeToken,
  useServiceAccounts,
  useSetMembershipPolicy,
  useTokens,
  useUpdateMembershipRole,
  useWhoami,
} from "@/hooks/use-admin";
import { useAuth } from "@/hooks/use-auth";
import type {
  ProjectMembership,
  ProjectMembershipMode,
  ProjectRole,
} from "@tila/schemas";
import { useId, useState } from "react";

const MODES: ProjectMembershipMode[] = [
  "explicit",
  "github-mirrored",
  "hybrid",
  "service-only",
];

const UNAVAILABLE_CODES = new Set([
  "membership-unavailable",
  "auth-unavailable",
  "credential-unavailable",
  "permission-recheck-unavailable",
]);

function isUnavailable(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    UNAVAILABLE_CODES.has(String((error as { code: unknown }).code))
  );
}

export function SettingsPage() {
  const { refreshStatus } = useAuth();
  const {
    projectId,
    capabilities,
    canManageMemberships,
    canManageCredentials,
    membershipAvailable,
  } = useAdminCapabilities();
  const [stepUp, setStepUp] = useState(false);

  function trackStepUp<T>(promise: Promise<T>): Promise<T> {
    return promise.catch((err: unknown) => {
      if (isStepUpRequired(err)) setStepUp(true);
      throw err;
    });
  }

  if (!capabilities) {
    return (
      <div className="space-y-4 p-3 md:p-6">
        <Heading />
        <output className="block py-12 text-center text-muted-foreground">
          Loading session capabilities…
        </output>
      </div>
    );
  }

  if (!membershipAvailable) {
    return (
      <div className="space-y-4 p-3 md:p-6">
        <Heading />
        <div
          role="alert"
          className="flex flex-col items-center gap-3 py-12 text-center"
        >
          <p className="text-sm text-status-red">
            Membership policy store unavailable
          </p>
          <p className="text-xs text-muted-foreground">
            Management controls stay hidden until the policy store can be
            consulted again.
          </p>
          <Button variant="ghost" size="sm" onClick={() => refreshStatus()}>
            Retry
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-8 p-3 md:p-6">
      <Heading />
      {stepUp && <StepUpBanner onDismiss={() => setStepUp(false)} />}
      {canManageMemberships ? (
        <MembersSection projectId={projectId ?? ""} track={trackStepUp} />
      ) : (
        <section aria-labelledby="members-heading" className="space-y-2">
          <h2 id="members-heading" className="font-logo text-lg tracking-tight">
            Members
          </h2>
          <p className="py-6 text-center text-muted-foreground">
            You can view this project but cannot manage its members.
          </p>
        </section>
      )}
      {canManageCredentials ? (
        <CredentialsSection track={trackStepUp} />
      ) : (
        <section aria-labelledby="credentials-heading" className="space-y-2">
          <h2
            id="credentials-heading"
            className="font-logo text-lg tracking-tight"
          >
            Credentials
          </h2>
          <p className="py-6 text-center text-muted-foreground">
            You can view this project but cannot manage its credentials.
          </p>
        </section>
      )}
    </div>
  );
}

function Heading() {
  return (
    <div className="flex items-center gap-3">
      <h1 className="font-logo text-xl tracking-tight text-foreground">
        Settings
      </h1>
    </div>
  );
}

type Track = <T>(promise: Promise<T>) => Promise<T>;

function MembersSection({
  projectId,
  track,
}: {
  projectId: string;
  track: Track;
}) {
  const policy = useMembershipPolicy();
  const memberships = useMemberships(true);
  const events = useMembershipEvents(20);
  const repos = useMembershipRepos();
  const serviceAccounts = useServiceAccounts();
  const me = useWhoami();
  const grant = useGrantMembership();
  const updateRole = useUpdateMembershipRole();
  const revoke = useRevokeMembership();
  const setMode = useSetMembershipPolicy();
  const [pendingMode, setPendingMode] = useState<ProjectMembershipMode | null>(
    null,
  );
  const [modeError, setModeError] = useState<string | null>(null);
  const [roleError, setRoleError] = useState<string | null>(null);
  const modeId = useId();

  const rows = memberships.data?.memberships ?? [];
  const accounts = serviceAccounts.data?.service_accounts ?? [];
  const ownMembership = rows.find(
    (m) => m.revoked_at === null && m.principal_id === me.data?.principal_id,
  );
  const activeCount = rows.filter((m) => m.revoked_at === null).length;

  async function applyMode(mode: ProjectMembershipMode) {
    setModeError(null);
    try {
      await track(setMode.mutateAsync(mode));
      setPendingMode(null);
    } catch (err) {
      if (isStepUpRequired(err)) {
        setPendingMode(null);
        return;
      }
      setModeError(err instanceof Error ? err.message : "Update failed");
    }
  }

  function requestMode(mode: ProjectMembershipMode) {
    if (mode === policy.data?.mode) return;
    if (policy.data?.mode === "explicit" && mode !== "service-only") {
      // Leaving explicit mode widens access to GitHub collaborators.
      setPendingMode(mode);
      return;
    }
    void applyMode(mode);
  }

  async function changeRole(membership: ProjectMembership, role: ProjectRole) {
    setRoleError(null);
    try {
      await track(
        updateRole.mutateAsync({
          membershipId: membership.membership_id,
          role,
        }),
      );
    } catch (err) {
      if (!isStepUpRequired(err))
        setRoleError(err instanceof Error ? err.message : "Update failed");
    }
  }

  const listError = memberships.error ?? policy.error;
  const pendingId =
    (updateRole.isPending ? updateRole.variables?.membershipId : null) ??
    (revoke.isPending ? revoke.variables : null) ??
    null;

  return (
    <section aria-labelledby="members-heading" className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h2 id="members-heading" className="font-logo text-lg tracking-tight">
          Members
        </h2>
        {activeCount > 0 && (
          <span className="tila-num rounded-full border border-border bg-card px-[7px] py-px font-mono text-[11px] text-fg-faint">
            {activeCount}
          </span>
        )}
        {policy.data?.mode && <Badge variant="gray">{policy.data.mode}</Badge>}
        <label
          htmlFor={modeId}
          className="ml-auto flex items-center gap-2 text-xs text-muted-foreground"
        >
          Policy mode
          <select
            id={modeId}
            value={policy.data?.mode ?? "explicit"}
            disabled={!policy.data || setMode.isPending}
            onChange={(e) =>
              requestMode(e.target.value as ProjectMembershipMode)
            }
            className="h-7 rounded-md border border-input bg-transparent px-2 font-mono text-xs text-foreground"
          >
            {MODES.map((mode) => (
              <option key={mode} value={mode}>
                {mode}
              </option>
            ))}
          </select>
        </label>
        <LastRefreshed dataUpdatedAt={memberships.dataUpdatedAt} />
      </div>
      {modeError && (
        <p role="alert" className="text-sm text-status-red">
          {modeError}
        </p>
      )}

      {listError && isUnavailable(listError) ? (
        <TableError error={listError} onRetry={() => memberships.refetch()} />
      ) : listError ? (
        <TableError error={listError} onRetry={() => memberships.refetch()} />
      ) : (
        <>
          <MembersTable
            memberships={rows}
            serviceAccounts={accounts}
            callerPrincipalId={me.data?.principal_id}
            isLoading={memberships.isLoading}
            pendingId={pendingId}
            error={roleError}
            onChangeRole={changeRole}
            onRevoke={(m) =>
              track(revoke.mutateAsync(m.membership_id)).then(() => undefined)
            }
          />
          <GrantMemberForm
            serviceAccounts={accounts}
            memberships={rows}
            pending={grant.isPending}
            onGrant={(body) => track(grant.mutateAsync(body))}
          />
          <MirroredAccessPanel
            mode={policy.data?.mode}
            repos={repos.data?.repos ?? []}
            me={me.data}
            ownMembership={ownMembership}
          />
          <MembershipEvents
            projectId={projectId}
            events={events.data?.events ?? []}
            nextCursor={events.data?.next_cursor ?? null}
            isLoading={events.isLoading}
          />
        </>
      )}

      <ConfirmAction
        open={pendingMode !== null}
        onOpenChange={(open) => {
          if (!open) setPendingMode(null);
        }}
        title="Change membership policy"
        description={
          <>
            Switching from <span className="font-mono">explicit</span> to{" "}
            <span className="font-mono">{pendingMode}</span> lets GitHub
            collaborators on linked repositories access this project without an
            explicit grant.
          </>
        }
        confirmLabel="Change policy"
        pending={setMode.isPending}
        error={modeError}
        onConfirm={() => pendingMode && applyMode(pendingMode)}
      />
    </section>
  );
}

function CredentialsSection({ track }: { track: Track }) {
  const tokens = useTokens();
  const serviceAccounts = useServiceAccounts();
  const revoke = useRevokeToken();
  const list = tokens.data?.tokens ?? [];

  return (
    <section aria-labelledby="credentials-heading" className="space-y-4">
      <div className="flex items-center gap-3">
        <h2
          id="credentials-heading"
          className="font-logo text-lg tracking-tight"
        >
          Credentials
        </h2>
        {list.length > 0 && (
          <span className="tila-num rounded-full border border-border bg-card px-[7px] py-px font-mono text-[11px] text-fg-faint">
            {list.length}
          </span>
        )}
        <LastRefreshed dataUpdatedAt={tokens.dataUpdatedAt} />
      </div>
      {tokens.error ? (
        <TableError error={tokens.error} onRetry={() => tokens.refetch()} />
      ) : (
        <CredentialsTable
          tokens={list}
          serviceAccounts={serviceAccounts.data?.service_accounts ?? []}
          isLoading={tokens.isLoading}
          pendingName={revoke.isPending ? (revoke.variables ?? null) : null}
          onRevoke={(name) =>
            track(revoke.mutateAsync(name)).then(() => undefined)
          }
        />
      )}
    </section>
  );
}
