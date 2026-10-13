import {
  AccessPolicyDrawer,
  OidcPolicyDrawer,
  RegisterRepoDrawer,
  repoName,
  repoTarget,
} from "@/components/settings/repo-editors";
import {
  ManageNote,
  OwnerStepUp,
  SettingsHeading,
} from "@/components/settings/settings-ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmAction } from "@/components/ui/confirm-action";
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
  useRepoLinks,
  useStepUp,
} from "@/hooks/use-access-settings";
import { useAdminCapabilities, useWhoami } from "@/hooks/use-admin";
import { removeRepoLink } from "@/lib/api";
import {
  failureKind,
  failureMessage,
  revisionConflict,
} from "@/lib/mutation-errors";
import { deriveSectionState } from "@/lib/query-state";
import { useMutation } from "@tanstack/react-query";
import type { RepoLink } from "@tila/schemas";
import { useState } from "react";
import { Link } from "react-router";

const linkKey = (link: RepoLink) =>
  `${link.github_host}/${link.github_repo_id}`;

type Open =
  | { kind: "register" }
  | { kind: "access" | "oidc" | "remove"; key: string };

export function SettingsRepositoriesPage() {
  const { projectId, canManageRepositories } = useAdminCapabilities();
  const whoami = useWhoami();
  const repos = useRepoLinks(canManageRepositories);
  const state = deriveSectionState(repos);
  const stepUp = useStepUp();
  const [open, setOpen] = useState<Open | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const principal = whoami.data?.principal_id ?? null;
  const target =
    open && open.kind !== "register"
      ? repos.data?.find((link) => linkKey(link) === open.key)
      : undefined;
  const close = () => setOpen(null);
  const show = (next: Open) => {
    setNotice(null);
    setOpen(next);
  };

  return (
    <div className="space-y-6 p-3 md:p-6">
      <SettingsHeading
        title="Repositories"
        actions={
          canManageRepositories && (
            <Button type="button" onClick={() => show({ kind: "register" })}>
              Link repository
            </Button>
          )
        }
      >
        GitHub repositories linked to this project. Their access policy decides
        how far collaborators' GitHub sign-ins reach; their Actions OIDC policy
        decides which workflow runs may exchange a token. Explicit members are
        managed in{" "}
        <Link className="underline" to={`/p/${projectId}/settings`}>
          Settings › Access
        </Link>
        .
      </SettingsHeading>
      {stepUp.required && <OwnerStepUp onDismiss={stepUp.dismiss} />}
      {notice && <FormNotice tone="info">{notice}</FormNotice>}
      {!canManageRepositories ? (
        <ManageNote>
          Only a project owner (or a credential with repository-policy:manage)
          can view and change linked repositories.
        </ManageNote>
      ) : (
        <QuerySection
          state={state}
          label="linked repositories"
          empty="No repositories are linked to this project."
          forbidden="Your access does not include linked repositories."
          onRetry={() => void repos.refetch()}
        >
          {(links) => (
            <div className="overflow-x-auto rounded-lg border border-border">
              <Table aria-label="Repositories">
                <TableHeader>
                  <TableRow>
                    <TableHead>Repository</TableHead>
                    <TableHead>Human access</TableHead>
                    <TableHead>Actions OIDC</TableHead>
                    <TableHead>
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {links.map((link) => {
                    const name = repoName(link);
                    const access = link.access_policy;
                    const oidc = link.oidc_policy;
                    return (
                      <TableRow key={linkKey(link)} className="align-top">
                        <TableCell>
                          <div className="text-fg-strong">{name}</div>
                          <div className="text-xs text-muted-foreground">
                            {link.github_host} · #{link.github_repo_id}
                          </div>
                        </TableCell>
                        <TableCell className="text-xs">
                          {access ? (
                            <>
                              <div>
                                read ≥ {access.min_read_permission} · write ≥{" "}
                                {access.min_write_permission} · max{" "}
                                {access.max_permission}
                              </div>
                              <div className="text-muted-foreground">
                                mirroring{" "}
                                {access.membership_enabled
                                  ? `on, up to ${access.membership_role_cap}`
                                  : "off"}{" "}
                                · revision {link.access_policy_revision}
                              </div>
                            </>
                          ) : (
                            <Badge variant="amber">invalid policy</Badge>
                          )}
                        </TableCell>
                        <TableCell className="text-xs">
                          {oidc ? (
                            <>
                              <div>
                                {oidc.enabled
                                  ? `on · max ${oidc.max_permission}`
                                  : "off"}
                              </div>
                              <div className="text-muted-foreground">
                                {oidc.enabled &&
                                  `${oidc.allowed_events.join(", ")} · `}
                                revision {link.oidc_policy_revision}
                              </div>
                            </>
                          ) : (
                            <Badge variant="amber">invalid policy</Badge>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-1">
                            <Button
                              type="button"
                              size="xs"
                              variant="outline"
                              aria-label={`Access policy for ${name}`}
                              onClick={() =>
                                show({ kind: "access", key: linkKey(link) })
                              }
                            >
                              Access
                            </Button>
                            <Button
                              type="button"
                              size="xs"
                              variant="outline"
                              aria-label={`Actions OIDC policy for ${name}`}
                              onClick={() =>
                                show({ kind: "oidc", key: linkKey(link) })
                              }
                            >
                              OIDC
                            </Button>
                            <Button
                              type="button"
                              size="xs"
                              variant="ghost"
                              className="text-status-red"
                              aria-label={`Remove ${name}`}
                              onClick={() =>
                                show({ kind: "remove", key: linkKey(link) })
                              }
                            >
                              Remove
                            </Button>
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

      {open?.kind === "register" && (
        <RegisterRepoDrawer
          onClose={close}
          onStepUp={stepUp.caught}
          onRegistered={(fullName) => {
            close();
            setNotice(
              `Linked ${fullName}. Review its access and OIDC policies before relying on it.`,
            );
          }}
        />
      )}
      {open?.kind === "access" && target && (
        <AccessPolicyDrawer
          key={linkKey(target)}
          link={target}
          principal={principal}
          onClose={close}
          onStepUp={stepUp.caught}
          onSaved={() => {
            close();
            setNotice(`Saved the access policy of ${repoName(target)}.`);
          }}
        />
      )}
      {open?.kind === "oidc" && target && (
        <OidcPolicyDrawer
          key={linkKey(target)}
          link={target}
          principal={principal}
          onClose={close}
          onStepUp={stepUp.caught}
          onSaved={() => {
            close();
            setNotice(`Saved the Actions OIDC policy of ${repoName(target)}.`);
          }}
        />
      )}
      {open?.kind === "remove" && target && (
        <RemoveRepoDialog
          key={linkKey(target)}
          link={target}
          onClose={close}
          onStepUp={stepUp.caught}
          onRemoved={() => {
            close();
            setNotice(
              `Removed the link to ${repoName(target)}. Explicit memberships were kept.`,
            );
          }}
        />
      )}
    </div>
  );
}

/** Removes the link against the access-policy revision on screen. */
function RemoveRepoDialog({
  link,
  onClose,
  onRemoved,
  onStepUp,
}: {
  link: RepoLink;
  onClose: () => void;
  onRemoved: () => void;
  onStepUp: (error: unknown) => boolean;
}) {
  const invalidate = useInvalidateAccess();
  const name = repoName(link);
  const remove = useMutation({
    networkMode: "always",
    mutationFn: (revision: number) =>
      removeRepoLink(repoTarget(link), revision),
    onSuccess: () => {
      void invalidate.repos();
      onRemoved();
    },
    onError: (error) => {
      if (onStepUp(error)) return onClose();
      if (revisionConflict(error) || failureKind(error) === "unconfirmed")
        void invalidate.repos();
    },
  });
  const conflict = revisionConflict(remove.error);
  const error = !remove.error
    ? null
    : conflict
      ? `The access policy changed (revision ${conflict.revision}) after you opened this. Review the reloaded repository and confirm again.`
      : failureKind(remove.error) === "unconfirmed"
        ? `The server did not confirm the removal (${failureMessage(remove.error)}). Check the list: removing an already removed link is harmless.`
        : failureMessage(remove.error);

  return (
    <ConfirmAction
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={`Remove ${name}`}
      confirmText={name}
      confirmLabel="Remove link"
      pending={remove.isPending}
      error={error}
      onConfirm={() => remove.mutate(link.access_policy_revision)}
      description={
        <div className="space-y-2">
          <p>
            GitHub sign-ins and Actions token exchanges through {name} no longer
            grant access to this project.
          </p>
          <p>
            Explicit memberships are not removed, including ones for people who
            reached the project through this repository. Revoke those in
            Settings › Access.
          </p>
          <p className="font-mono text-xs">
            {link.github_host} · #{link.github_repo_id} · access policy revision{" "}
            {link.access_policy_revision}
          </p>
        </div>
      }
    />
  );
}
