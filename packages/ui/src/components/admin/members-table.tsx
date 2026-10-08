import { RoleSelect } from "@/components/admin/role-select";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmAction } from "@/components/ui/confirm-action";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { TableSkeleton } from "@/components/ui/table-skeleton";
import { ApiError, type ServiceAccount } from "@/lib/api";
import { formatDateTime, relativeTime } from "@/lib/time";
import type { ProjectMembership, ProjectRole } from "@tila/schemas";
import { useId, useMemo, useState } from "react";

export function principalLabel(
  membership: ProjectMembership,
  serviceAccounts: ServiceAccount[],
): string {
  if (membership.provider === "service") {
    const account = serviceAccounts.find(
      (a) => a.principal_id === membership.principal_id,
    );
    return account?.display_name || account?.name || membership.principal_id;
  }
  if (membership.provider === "github")
    return membership.display_name || `github user #${membership.subject_id}`;
  const subject =
    membership.subject_id.length > 24
      ? `${membership.subject_id.slice(0, 24)}…`
      : membership.subject_id;
  return membership.display_name || `${membership.identity_host} ${subject}`;
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return error instanceof Error ? error.message : "Request failed";
}

interface MembersTableProps {
  memberships: ProjectMembership[];
  serviceAccounts: ServiceAccount[];
  callerPrincipalId?: string;
  isLoading: boolean;
  pendingId: string | null;
  error: unknown;
  onChangeRole: (membership: ProjectMembership, role: ProjectRole) => void;
  onRevoke: (membership: ProjectMembership) => Promise<void>;
}

export function MembersTable({
  memberships,
  serviceAccounts,
  callerPrincipalId,
  isLoading,
  pendingId,
  error,
  onChangeRole,
  onRevoke,
}: MembersTableProps) {
  const [showRevoked, setShowRevoked] = useState(false);
  const [revoking, setRevoking] = useState<ProjectMembership | null>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const checkboxId = useId();

  const rows = useMemo(() => {
    const visible = showRevoked
      ? memberships
      : memberships.filter((m) => m.revoked_at === null);
    return [...visible].sort((a, b) => {
      if ((a.revoked_at === null) !== (b.revoked_at === null))
        return a.revoked_at === null ? -1 : 1;
      return b.granted_at - a.granted_at;
    });
  }, [memberships, showRevoked]);
  const activeOwners = memberships.filter(
    (m) => m.revoked_at === null && m.role === "owner",
  ).length;
  const revokedCount = memberships.filter((m) => m.revoked_at !== null).length;

  async function confirmRevoke() {
    if (!revoking) return;
    setRevokeError(null);
    try {
      await onRevoke(revoking);
      setRevoking(null);
    } catch (err) {
      if (err instanceof ApiError && err.code === "step-up-required") {
        setRevoking(null);
        return;
      }
      setRevokeError(errorMessage(err));
    }
  }

  return (
    <div className="space-y-2">
      {error ? (
        <p role="alert" className="text-sm text-status-red">
          {errorMessage(error)}
        </p>
      ) : null}
      <div className="overflow-hidden rounded-lg border border-border">
        <Table aria-label="Members">
          <TableHeader>
            <TableRow>
              <TableHead>Principal</TableHead>
              <TableHead>Kind</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Source</TableHead>
              <TableHead>Granted</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableSkeleton rows={3} columns={7} />
            ) : rows.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={7}
                  className="py-12 text-center text-muted-foreground"
                >
                  No explicit members. Grant one below.
                </TableCell>
              </TableRow>
            ) : (
              rows.map((m) => {
                const revoked = m.revoked_at !== null;
                const isCaller =
                  callerPrincipalId !== undefined &&
                  m.principal_id === callerPrincipalId;
                const lastOwner =
                  m.role === "owner" && !revoked && activeOwners <= 1;
                const busy = pendingId === m.membership_id;
                return (
                  <TableRow
                    key={m.membership_id}
                    className={revoked ? "opacity-60" : ""}
                  >
                    <TableCell className="text-fg-strong">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs">
                          {principalLabel(m, serviceAccounts)}
                        </span>
                        <Badge variant="gray">{m.provider}</Badge>
                        {isCaller && <Badge variant="default">you</Badge>}
                      </div>
                      <div className="font-mono text-[11px] text-muted-foreground">
                        {m.principal_id}
                      </div>
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {m.subject_kind}
                    </TableCell>
                    <TableCell>
                      {revoked ? (
                        <span className="font-mono text-xs">{m.role}</span>
                      ) : (
                        <RoleSelect
                          aria-label={`Role for ${principalLabel(m, serviceAccounts)}`}
                          value={m.role}
                          disabled={busy || lastOwner}
                          onChange={(role) => onChangeRole(m, role)}
                        />
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          m.granted_by.startsWith("bootstrap")
                            ? "gray"
                            : "default"
                        }
                      >
                        {m.granted_by.startsWith("bootstrap")
                          ? "bootstrap"
                          : "explicit"}
                      </Badge>
                    </TableCell>
                    <TableCell className="max-w-[18ch] text-xs text-muted-foreground">
                      <div className="truncate font-mono" title={m.granted_by}>
                        {m.granted_by}
                      </div>
                      <div
                        className="tila-num"
                        title={formatDateTime(m.granted_at)}
                      >
                        {relativeTime(m.granted_at)}
                      </div>
                    </TableCell>
                    <TableCell>
                      {revoked ? (
                        <Badge
                          variant="red"
                          title={
                            m.revoked_at === null
                              ? undefined
                              : formatDateTime(m.revoked_at)
                          }
                        >
                          revoked
                        </Badge>
                      ) : (
                        <Badge variant="green">active</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      {!revoked && (
                        <Button
                          variant="ghost"
                          size="xs"
                          className="text-status-red"
                          disabled={busy || lastOwner}
                          title={
                            lastOwner
                              ? "The last owner cannot be revoked"
                              : undefined
                          }
                          onClick={() => {
                            setRevokeError(null);
                            setRevoking(m);
                          }}
                        >
                          Revoke
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>
      {revokedCount > 0 && (
        <label
          htmlFor={checkboxId}
          className="flex w-fit cursor-pointer items-center gap-2 text-xs text-muted-foreground"
        >
          <Checkbox
            id={checkboxId}
            checked={showRevoked}
            onCheckedChange={(v) => setShowRevoked(v === true)}
          />
          Show revoked ({revokedCount})
        </label>
      )}
      <ConfirmAction
        open={revoking !== null}
        onOpenChange={(open) => {
          if (!open) setRevoking(null);
        }}
        title="Revoke membership"
        description={
          revoking ? (
            <>
              <span className="font-mono text-foreground">
                {principalLabel(revoking, serviceAccounts)}
              </span>{" "}
              loses access immediately. Sessions for this principal are deleted
              and credentials bound to it stop working. This cannot be undone;
              grant a new membership to restore access.
            </>
          ) : null
        }
        confirmLabel="Revoke"
        pending={revoking ? pendingId === revoking.membership_id : false}
        error={revokeError}
        onConfirm={confirmRevoke}
      />
    </div>
  );
}
