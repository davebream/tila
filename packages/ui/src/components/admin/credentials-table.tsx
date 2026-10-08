import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { CopyButton } from "@/components/ui/copy-button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
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
import type { TokenListItem } from "@tila/schemas";
import { useState } from "react";

type Status = "active" | "revoked" | "expired" | "disabled";

export function credentialStatus(token: TokenListItem, now: number): Status {
  if (token.status) return token.status;
  if (token.revoked_at) return "revoked";
  if (token.expires_at && token.expires_at * 1000 < now) return "expired";
  return "active";
}

const STATUS_VARIANT: Record<Status, "green" | "red" | "gray" | "amber"> = {
  active: "green",
  revoked: "red",
  expired: "gray",
  disabled: "amber",
};

function epochToMs(value: number): number {
  // Credential timestamps are epoch seconds; sessions use milliseconds.
  return value < 1e12 ? value * 1000 : value;
}

interface CredentialsTableProps {
  tokens: TokenListItem[];
  serviceAccounts: ServiceAccount[];
  isLoading: boolean;
  pendingName: string | null;
  onRevoke: (name: string) => Promise<void>;
}

export function CredentialsTable({
  tokens,
  serviceAccounts,
  isLoading,
  pendingName,
  onRevoke,
}: CredentialsTableProps) {
  const [revoking, setRevoking] = useState<TokenListItem | null>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const now = Date.now();

  const rows = [...tokens].sort((a, b) => {
    const sa = credentialStatus(a, now) === "active" ? 0 : 1;
    const sb = credentialStatus(b, now) === "active" ? 0 : 1;
    if (sa !== sb) return sa - sb;
    return b.created_at - a.created_at;
  });

  function principalLabel(token: TokenListItem): string {
    if (token.legacy || !token.principal_id) return "project token";
    const account = serviceAccounts.find(
      (a) => a.principal_id === token.principal_id,
    );
    return account?.display_name || account?.name || token.principal_id;
  }

  async function confirmRevoke() {
    if (!revoking) return;
    setRevokeError(null);
    try {
      await onRevoke(revoking.name);
      setRevoking(null);
    } catch (err) {
      if (err instanceof ApiError && err.code === "step-up-required") {
        setRevoking(null);
        return;
      }
      setRevokeError(err instanceof Error ? err.message : "Revoke failed");
    }
  }

  return (
    <div className="space-y-3">
      <div className="overflow-hidden rounded-lg border border-border">
        <Table aria-label="Credentials">
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Principal</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Policy</TableHead>
              <TableHead>Expires</TableHead>
              <TableHead>Last used</TableHead>
              <TableHead>Created</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableSkeleton rows={3} columns={8} />
            ) : rows.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={8}
                  className="py-12 text-center text-muted-foreground"
                >
                  No credentials issued for this project.
                </TableCell>
              </TableRow>
            ) : (
              rows.map((token) => {
                const status = credentialStatus(token, now);
                const policy = token.effective_policy ?? token.policy;
                const capabilities = policy?.capabilities ?? [];
                const busy = pendingName === token.name;
                return (
                  <TableRow
                    key={token.credential_id ?? token.token_id ?? token.name}
                    className={status === "active" ? "" : "opacity-60"}
                  >
                    <TableCell className="font-mono text-xs text-fg-strong">
                      <div className="flex items-center gap-2">
                        {token.name}
                        {token.legacy && <Badge variant="gray">legacy</Badge>}
                        {token.versions && token.versions.length > 1 && (
                          <Badge variant="gray">
                            {token.versions.length} versions
                          </Badge>
                        )}
                      </div>
                      {token.note && (
                        <div className="font-sans text-[11px] text-muted-foreground">
                          {token.note}
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {principalLabel(token)}
                    </TableCell>
                    <TableCell>
                      <Badge variant={STATUS_VARIANT[status]}>{status}</Badge>
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {policy ? (
                        <Popover>
                          <PopoverTrigger asChild>
                            <button
                              type="button"
                              className="cursor-pointer underline decoration-dotted underline-offset-2"
                            >
                              {policy.role} · {capabilities.length} cap
                              {capabilities.length === 1 ? "" : "s"}
                            </button>
                          </PopoverTrigger>
                          <PopoverContent align="start" className="w-64">
                            <p className="tila-label mb-2">Capabilities</p>
                            {capabilities.length === 0 ? (
                              <p className="text-xs text-muted-foreground">
                                none
                              </p>
                            ) : (
                              <ul className="max-h-60 space-y-0.5 overflow-y-auto font-mono text-xs">
                                {capabilities.map((cap) => (
                                  <li key={cap}>{cap}</li>
                                ))}
                              </ul>
                            )}
                          </PopoverContent>
                        </Popover>
                      ) : (
                        <span className="text-muted-foreground">
                          {token.scopes}
                        </span>
                      )}
                    </TableCell>
                    <TableCell
                      className="tila-num text-xs text-muted-foreground"
                      title={
                        token.expires_at
                          ? formatDateTime(epochToMs(token.expires_at))
                          : undefined
                      }
                    >
                      {token.expires_at
                        ? formatDateTime(epochToMs(token.expires_at))
                        : "never"}
                    </TableCell>
                    <TableCell className="tila-num text-xs text-muted-foreground">
                      {token.last_used_at
                        ? relativeTime(epochToMs(token.last_used_at))
                        : "never"}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      <div className="font-mono">{token.created_by}</div>
                      <div className="tila-num">
                        {relativeTime(epochToMs(token.created_at))}
                      </div>
                    </TableCell>
                    <TableCell className="text-right">
                      {status !== "revoked" && (
                        <Button
                          variant="ghost"
                          size="xs"
                          className="text-status-red"
                          disabled={busy}
                          onClick={() => {
                            setRevokeError(null);
                            setRevoking(token);
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

      <div className="space-y-1 text-xs text-muted-foreground">
        <p>
          Issuance and rotation are not available in the browser. Issue
          credentials from the CLI:
        </p>
        {[
          "tila service-account create --name <name> --display-name <label>",
          "tila token issue --principal service:<uuid> --preset read-only",
        ].map((cmd) => (
          <div key={cmd} className="group/row flex items-center gap-1">
            <code className="tila-code font-mono text-[11px] text-fg-strong">
              {cmd}
            </code>
            <CopyButton value={cmd} />
          </div>
        ))}
        <p>Revoking a credential also deletes every session minted from it.</p>
      </div>

      <ConfirmAction
        open={revoking !== null}
        onOpenChange={(open) => {
          if (!open) setRevoking(null);
        }}
        title="Revoke credential"
        description={
          revoking ? (
            <>
              Clients using{" "}
              <span className="font-mono text-foreground">{revoking.name}</span>{" "}
              lose access immediately, including every rotated version and any
              browser session exchanged from it. This cannot be undone.
            </>
          ) : null
        }
        confirmText={revoking?.name}
        confirmLabel="Revoke"
        pending={revoking ? pendingName === revoking.name : false}
        error={revokeError}
        onConfirm={confirmRevoke}
      />
    </div>
  );
}
