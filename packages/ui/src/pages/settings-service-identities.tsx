import {
  CreateServiceAccountDrawer,
  RenameServiceAccountDrawer,
  WorkloadBindingsDrawer,
} from "@/components/settings/service-identity-editors";
import {
  ManageNote,
  OwnerStepUp,
  SettingsHeading,
} from "@/components/settings/settings-ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { CopyButton } from "@/components/ui/copy-button";
import { FormNotice } from "@/components/ui/form-fields";
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
  useServiceAccountList,
  useStepUp,
} from "@/hooks/use-access-settings";
import { isStepUpRequired, useAdminCapabilities } from "@/hooks/use-admin";
import { type ServiceAccount, revokeServiceAccount } from "@/lib/api";
import { failureKind, failureMessage } from "@/lib/mutation-errors";
import { deriveSectionState } from "@/lib/query-state";
import { formatDateTime } from "@/lib/time";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";

type Open =
  | { kind: "create" }
  | { kind: "rename" | "bindings" | "revoke"; principal: string };

/** Account timestamps are epoch seconds. */
const toMs = (value: number) => (value < 1e12 ? value * 1000 : value);

export function SettingsServiceIdentitiesPage() {
  const { projectId, canManageServiceAccounts, canManageWorkloadBindings } =
    useAdminCapabilities();
  const readable = canManageServiceAccounts || canManageWorkloadBindings;
  const accounts = useServiceAccountList(readable);
  const state = deriveSectionState(accounts, {
    isEmpty: (data) => data.service_accounts.length === 0,
  });
  const stepUp = useStepUp();
  const [open, setOpen] = useState<Open | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const target =
    open && open.kind !== "create"
      ? accounts.data?.service_accounts.find(
          (account) => account.principal_id === open.principal,
        )
      : undefined;
  const close = () => setOpen(null);
  const show = (next: Open) => {
    setNotice(null);
    setOpen(next);
  };

  return (
    <div className="space-y-6 p-3 md:p-6">
      <SettingsHeading
        title="Service identities"
        actions={
          canManageServiceAccounts && (
            <Button type="button" onClick={() => show({ kind: "create" })}>
              Create service account
            </Button>
          )
        }
      >
        Non-human principals for automation. Each service account has its own
        membership; credentials and workload bindings act as it and can never
        exceed it.
      </SettingsHeading>
      {stepUp.required && <OwnerStepUp onDismiss={stepUp.dismiss} />}
      {notice && <FormNotice tone="info">{notice}</FormNotice>}
      {!readable ? (
        <ManageNote>
          Only a project owner (or a credential with service-accounts:manage or
          workload-bindings:manage) can view and change service identities.
        </ManageNote>
      ) : (
        <QuerySection
          state={state}
          label="service accounts"
          empty="No service accounts."
          forbidden="Your access does not include service accounts."
          onRetry={() => void accounts.refetch()}
        >
          {(data) => (
            <div className="overflow-x-auto rounded-lg border border-border">
              <Table aria-label="Service accounts">
                <TableHeader>
                  <TableRow>
                    <TableHead>Account</TableHead>
                    <TableHead>Principal</TableHead>
                    <TableHead>State</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead>
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {[...data.service_accounts]
                    .sort(
                      (a, b) =>
                        Number(a.revoked_at !== null) -
                          Number(b.revoked_at !== null) ||
                        a.name.localeCompare(b.name),
                    )
                    .map((account) => {
                      const active = account.revoked_at === null;
                      return (
                        <TableRow
                          key={account.principal_id}
                          className={
                            active ? "align-top" : "align-top opacity-60"
                          }
                        >
                          <TableCell>
                            <div className="font-sans text-fg-strong">
                              {account.display_name}
                            </div>
                            <div className="text-xs text-muted-foreground">
                              {account.name}
                            </div>
                          </TableCell>
                          <TableCell className="text-xs">
                            <span className="inline-flex items-center gap-1">
                              {account.principal_id}
                              <CopyButton value={account.principal_id} />
                            </span>
                          </TableCell>
                          <TableCell>
                            {active ? (
                              <Badge variant="green">active</Badge>
                            ) : (
                              <Badge variant="red">revoked</Badge>
                            )}
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">
                            {formatDateTime(toMs(account.created_at))}
                            <div className="truncate">{account.created_by}</div>
                          </TableCell>
                          <TableCell className="text-right">
                            <div className="flex justify-end gap-1">
                              {canManageWorkloadBindings && (
                                <Button
                                  type="button"
                                  size="xs"
                                  variant="outline"
                                  aria-label={`Workload bindings of ${account.name}`}
                                  onClick={() =>
                                    show({
                                      kind: "bindings",
                                      principal: account.principal_id,
                                    })
                                  }
                                >
                                  Bindings
                                </Button>
                              )}
                              {canManageServiceAccounts && active && (
                                <>
                                  <Button
                                    type="button"
                                    size="xs"
                                    variant="outline"
                                    aria-label={`Rename ${account.name}`}
                                    onClick={() =>
                                      show({
                                        kind: "rename",
                                        principal: account.principal_id,
                                      })
                                    }
                                  >
                                    Rename
                                  </Button>
                                  <Button
                                    type="button"
                                    size="xs"
                                    variant="ghost"
                                    className="text-status-red"
                                    aria-label={`Revoke ${account.name}`}
                                    onClick={() =>
                                      show({
                                        kind: "revoke",
                                        principal: account.principal_id,
                                      })
                                    }
                                  >
                                    Revoke
                                  </Button>
                                </>
                              )}
                            </div>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                </TableBody>
              </Table>
            </div>
          )}
        </QuerySection>
      )}
      {readable && !canManageServiceAccounts && (
        <ManageNote>
          You can manage workload bindings but not the accounts themselves.
        </ManageNote>
      )}

      {open?.kind === "create" && (
        <CreateServiceAccountDrawer
          onClose={close}
          onStepUp={stepUp.caught}
          onCreated={(account) => {
            close();
            setNotice(
              `Created ${account.name} (${account.principal_id}). Issue it a credential in Settings › Credentials or add a workload binding.`,
            );
          }}
        />
      )}
      {open?.kind === "rename" && target && (
        <RenameServiceAccountDrawer
          account={target}
          onClose={close}
          onStepUp={stepUp.caught}
          onSaved={(account) => {
            close();
            setNotice(`Renamed ${account.name} to ${account.display_name}.`);
          }}
        />
      )}
      {open?.kind === "bindings" && target && (
        <WorkloadBindingsDrawer
          account={target}
          canManage={canManageWorkloadBindings}
          onClose={close}
          onStepUp={stepUp.caught}
        />
      )}
      {open?.kind === "revoke" && target && projectId && (
        <RevokeAccountDialog
          project={projectId}
          account={target}
          onClose={close}
          onStepUp={stepUp.caught}
          onRevoked={() => {
            close();
            setNotice(
              `Revoked ${target.name}. Its credentials and workload bindings no longer work; past actions stay attributed to it.`,
            );
          }}
        />
      )}
    </div>
  );
}

function RevokeAccountDialog({
  project,
  account,
  onClose,
  onRevoked,
  onStepUp,
}: {
  project: string;
  account: ServiceAccount;
  onClose: () => void;
  onRevoked: () => void;
  onStepUp: (error: unknown) => boolean;
}) {
  const invalidate = useInvalidateAccess();
  const revoke = useMutation({
    networkMode: "always",
    mutationFn: () => revokeServiceAccount(project, account.principal_id),
    onSuccess: () => {
      void invalidate.services();
      onRevoked();
    },
    onError: (error) => {
      if (onStepUp(error)) onClose();
    },
  });
  const error =
    revoke.error && !isStepUpRequired(revoke.error)
      ? failureKind(revoke.error) === "unconfirmed"
        ? "The server did not confirm the revocation. Check the list; revoking twice is harmless."
        : failureMessage(revoke.error)
      : null;
  return (
    <ConfirmAction
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={`Revoke ${account.name}`}
      confirmText={account.name}
      confirmLabel="Revoke account"
      pending={revoke.isPending}
      error={error}
      onConfirm={() => revoke.mutate()}
      description={
        <div className="space-y-2">
          <p>
            Its membership ends, every credential issued to it stops working,
            its workload bindings stop exchanging tokens, and agent bindings it
            holds are released.
          </p>
          <p>
            The principal ID {account.principal_id} stays in the journal and
            history, so past actions remain attributed to {account.name}. This
            cannot be undone.
          </p>
        </div>
      }
    />
  );
}
