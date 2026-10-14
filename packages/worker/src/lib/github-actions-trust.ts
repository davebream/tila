import { isBlockedHost } from "@tila/core";
import {
  GITHUB_ACTIONS_HOST,
  GITHUB_ACTIONS_ISSUER,
  GITHUB_ACTIONS_JWKS_URI,
  type GitHubActionsTrustedIssuer,
  GitHubActionsTrustedIssuersSchema,
} from "@tila/schemas";

const githubCom: GitHubActionsTrustedIssuer = {
  issuer: GITHUB_ACTIONS_ISSUER,
  host: GITHUB_ACTIONS_HOST,
  jwks_uri: GITHUB_ACTIONS_JWKS_URI,
};

/** No discovery or network I/O. Invalid deployment configuration trusts nothing. */
export function actionsTrustedIssuers(
  raw?: string,
): GitHubActionsTrustedIssuer[] | null {
  try {
    const entries = GitHubActionsTrustedIssuersSchema.parse(
      raw === undefined ? [] : JSON.parse(raw),
    );
    if (
      entries.some(
        (entry) =>
          isBlockedHost(new URL(entry.issuer).hostname) ||
          isBlockedHost(new URL(entry.jwks_uri).hostname) ||
          isBlockedHost(entry.host),
      )
    )
      return null;
    return [githubCom, ...entries];
  } catch {
    return null;
  }
}

/** Unverified iss can select an exact configured entry, never establish authority. */
export function trustedActionsIssuer(issuer: string, raw?: string) {
  return (
    actionsTrustedIssuers(raw)?.find((entry) => entry.issuer === issuer) ?? null
  );
}
