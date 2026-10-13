import { CredentialsTable } from "@/components/admin/credentials-table";
import {
  IssueCredentialDrawer,
  RotateCredentialDrawer,
} from "@/components/settings/credential-editors";
import { policySummary } from "@/components/settings/policy-fields";
import { SecretReveal } from "@/components/settings/secret-reveal";
import {
  ManageNote,
  OwnerStepUp,
  SettingsHeading,
} from "@/components/settings/settings-ui";
import { Button } from "@/components/ui/button";
import { FormNotice } from "@/components/ui/form-fields";
import { LastRefreshed } from "@/components/ui/last-refreshed";
import { SectionFailure, StaleNotice } from "@/components/ui/query-section";
import { useServiceAccountList, useStepUp } from "@/hooks/use-access-settings";
import {
  useAdminCapabilities,
  useRevokeToken,
  useTokens,
} from "@/hooks/use-admin";
import type { IssuedCredential } from "@/lib/api";
import { deriveSectionState } from "@/lib/query-state";
import { formatDateTime } from "@/lib/time";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

/** A secret held only in this page's state until dismissed or unmounted. */
type Revealed = {
  title: string;
  credential: IssuedCredential;
  detail: string[];
};

export function SettingsCredentialsPage() {
  const {
    projectId,
    canReadCredentials,
    canIssueCredentials,
    canRotateCredentials,
    canRevokeCredentials,
  } = useAdminCapabilities();
  const client = useQueryClient();
  const tokens = useTokens();
  const accounts = useServiceAccountList(
    canReadCredentials || canIssueCredentials,
  );
  const revoke = useRevokeToken();
  const stepUp = useStepUp();
  const [issuing, setIssuing] = useState(false);
  const [rotating, setRotating] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<Revealed | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const list = tokens.data?.tokens ?? [];
  const tokensState = deriveSectionState(tokens);
  const serviceAccounts = accounts.data?.service_accounts ?? [];
  const rotatingToken = list.find((token) => token.name === rotating);
  const reload = () =>
    client.invalidateQueries({ queryKey: ["tokens", projectId] });

  return (
    <div className="space-y-6 p-3 md:p-6">
      <SettingsHeading
        title="Credentials"
        actions={
          canIssueCredentials && (
            <Button
              type="button"
              onClick={() => {
                setNotice(null);
                setIssuing(true);
              }}
            >
              Issue credential
            </Button>
          )
        }
      >
        Scoped API credentials for service accounts. A credential acts as its
        account and never exceeds the account's membership or the access of
        whoever issued it.
      </SettingsHeading>
      {stepUp.required && <OwnerStepUp onDismiss={stepUp.dismiss} />}
      {revealed && (
        <SecretReveal
          title={revealed.title}
          secret={revealed.credential.token}
          onDismiss={() => setRevealed(null)}
        >
          {revealed.detail.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </SecretReveal>
      )}
      {notice && <FormNotice tone="info">{notice}</FormNotice>}
      {!canReadCredentials ? (
        <ManageNote>
          Only a project owner (or a credential with tokens:read) can list
          credentials.
          {canIssueCredentials &&
            " You can still issue one; it will not appear here."}
        </ManageNote>
      ) : (
        <section aria-labelledby="credentials-heading" className="space-y-4">
          <div className="flex items-center gap-3">
            <h2
              id="credentials-heading"
              className="font-logo text-lg tracking-tight"
            >
              Issued credentials
            </h2>
            {list.length > 0 && (
              <span className="tila-num rounded-full border border-border bg-card px-[7px] py-px font-mono text-[11px] text-fg-faint">
                {list.length}
              </span>
            )}
            <LastRefreshed dataUpdatedAt={tokens.dataUpdatedAt} />
          </div>
          {tokensState.phase === "failed" ? (
            <SectionFailure
              kind={tokensState.kind}
              error={tokensState.error}
              label="credentials"
              onRetry={() => void tokens.refetch()}
            />
          ) : (
            <>
              {tokensState.phase === "ready" && tokensState.stale && (
                <StaleNotice
                  label="credentials"
                  updatedAt={tokensState.updatedAt}
                  stale={tokensState.stale}
                  onRetry={() => void tokens.refetch()}
                />
              )}
              <CredentialsTable
                tokens={list}
                serviceAccounts={serviceAccounts}
                isLoading={tokens.isLoading}
                pendingName={
                  revoke.isPending ? (revoke.variables ?? null) : null
                }
                onRevoke={
                  canRevokeCredentials
                    ? (name) =>
                        revoke.mutateAsync(name).then(
                          () => undefined,
                          (error: unknown) => {
                            stepUp.caught(error);
                            throw error;
                          },
                        )
                    : undefined
                }
                onRotate={
                  canRotateCredentials
                    ? (token) => {
                        setNotice(null);
                        setRotating(token.name);
                      }
                    : undefined
                }
              />
            </>
          )}
        </section>
      )}

      {issuing && projectId && (
        <IssueCredentialDrawer
          project={projectId}
          accounts={serviceAccounts.filter(
            (account) => account.revoked_at === null,
          )}
          accountsUnavailable={accounts.isError}
          onClose={() => setIssuing(false)}
          onStepUp={stepUp.caught}
          onUnconfirmed={() => void reload()}
          onIssued={(credential, requested) => {
            setIssuing(false);
            void reload();
            const granted = credential.policy?.capabilities.length;
            setRevealed({
              title: `Credential ${credential.name} issued`,
              credential,
              detail: [
                credential.policy
                  ? `Effective policy: ${policySummary(credential.policy)}.`
                  : "",
                granted !== undefined && granted < requested
                  ? `The server kept ${granted} of the ${requested} requested capabilities, to fit the account's membership.`
                  : "",
                credential.expires_at
                  ? `Expires ${formatDateTime(credential.expires_at * 1000)}.`
                  : "Never expires.",
              ].filter(Boolean),
            });
          }}
        />
      )}
      {rotating && rotatingToken && (
        <RotateCredentialDrawer
          token={rotatingToken}
          onClose={() => setRotating(null)}
          onStepUp={stepUp.caught}
          onChanged={() => void reload()}
          onRotated={(credential, overlap) => {
            setRotating(null);
            void reload();
            setRevealed({
              title: `New secret for ${credential.name}`,
              credential,
              detail: [
                overlap === 0
                  ? "The previous secret stopped working now."
                  : `The previous secret keeps working until ${formatDateTime(Date.now() + overlap * 1000)}.`,
              ],
            });
          }}
        />
      )}
    </div>
  );
}
