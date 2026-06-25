import { SignJWT, importPKCS8 } from "jose";
import { GITHUB_API_TIMEOUT_MS } from "../config";
import { githubFetch } from "./github-fetch";

/**
 * Discriminated union returned by checkUserMembershipStatus.
 *   - {kind:"permission", value} — HTTP 200, user is a collaborator at the given level
 *   - {kind:"absent"}           — HTTP 404, user is definitively not a collaborator
 *   - {kind:"error"}            — any other non-200 status or network/timeout error
 */
export type MembershipStatus =
  | { kind: "permission"; value: string }
  | { kind: "absent" }
  | { kind: "error" };

/**
 * Error thrown by getInstallationAccessToken (and future App-token helpers) when
 * the GitHub API returns a non-200 status. Callers can inspect `.status` to
 * distinguish a 404 (installation not found) from a 5xx transient error.
 */
export class GitHubAppTokenError extends Error {
  constructor(
    public readonly status: number,
    message?: string,
  ) {
    super(message ?? `GitHub API returned ${status}`);
    this.name = "GitHubAppTokenError";
  }
}

/**
 * Mint a GitHub App JWT for authentication.
 * The JWT is valid for 10 minutes (GitHub maximum).
 *
 * @param appId - GitHub App ID (numeric)
 * @param privateKeyPem - RSA private key in PEM format
 * @returns Compact JWT string
 */
export async function mintAppJwt(
  appId: number,
  privateKeyPem: string,
): Promise<string> {
  const privateKey = await importPKCS8(privateKeyPem, "RS256");

  const now = Math.floor(Date.now() / 1000);

  // GitHub requires iss to be numeric; cast through unknown to satisfy jose's string typing.
  return new SignJWT({ iss: appId as unknown as string })
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuedAt(now)
    .setExpirationTime(now + 600)
    .sign(privateKey);
}

/**
 * Get an installation access token for a GitHub App installation.
 *
 * @param appJwt - GitHub App JWT from mintAppJwt
 * @param installationId - GitHub App installation ID
 * @param apiBase - GitHub API base URL (default: https://api.github.com)
 * @returns Installation access token
 * @throws on non-200 response
 */
export async function getInstallationAccessToken(
  appJwt: string,
  installationId: number,
  apiBase = "https://api.github.com",
): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GITHUB_API_TIMEOUT_MS);

  try {
    const res = await githubFetch(
      `${apiBase}/app/installations/${installationId}/access_tokens`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${appJwt}`,
        },
        signal: controller.signal,
      },
    );

    if (!res.ok) {
      throw new GitHubAppTokenError(res.status);
    }

    const data = (await res.json()) as { token: string };
    return data.token;
  } finally {
    clearTimeout(timeout);
  }
}

export interface InstallationRepo {
  id: number;
  fullName: string;
  owner: string;
  name: string;
}

const MAX_REPO_PAGES = 50;

/**
 * List all repositories accessible to a GitHub App installation.
 * Paginates automatically up to MAX_REPO_PAGES pages.
 *
 * @param installationToken - Installation access token from getInstallationAccessToken
 * @param apiBase - GitHub API base URL (default: https://api.github.com)
 * @returns Array of installation repositories
 * @throws on non-200 response
 */
export async function listInstallationRepositories(
  installationToken: string,
  apiBase = "https://api.github.com",
): Promise<InstallationRepo[]> {
  const repos: InstallationRepo[] = [];
  let page = 1;
  const perPage = 100;

  while (page <= MAX_REPO_PAGES) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), GITHUB_API_TIMEOUT_MS);
    try {
      const res = await githubFetch(
        `${apiBase}/installation/repositories?per_page=${perPage}&page=${page}`,
        {
          headers: {
            Authorization: `Bearer ${installationToken}`,
          },
          signal: controller.signal,
        },
      );
      if (!res.ok) throw new Error(`GitHub API returned ${res.status}`);
      const data = (await res.json()) as {
        repositories: {
          id: number;
          full_name: string;
          owner: { login: string };
          name: string;
        }[];
      };
      for (const r of data.repositories) {
        repos.push({
          id: r.id,
          fullName: r.full_name,
          owner: r.owner.login,
          name: r.name,
        });
      }
      if (data.repositories.length < perPage) break;
      page++;
    } finally {
      clearTimeout(timeout);
    }
  }
  return repos;
}

/**
 * Status-aware variant of checkUserMembership that distinguishes a definitive
 * 404 ("not a collaborator") from a transient error (5xx / network timeout).
 *
 * @param installationToken - Installation access token from getInstallationAccessToken
 * @param owner - Repository owner
 * @param repo - Repository name
 * @param login - GitHub username to check
 * @param apiBase - GitHub API base URL (default: https://api.github.com)
 * @returns MembershipStatus discriminated union
 */
export async function checkUserMembershipStatus(
  installationToken: string,
  owner: string,
  repo: string,
  login: string,
  apiBase = "https://api.github.com",
): Promise<MembershipStatus> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GITHUB_API_TIMEOUT_MS);

  try {
    const res = await githubFetch(
      `${apiBase}/repos/${owner}/${repo}/collaborators/${login}/permission`,
      {
        headers: {
          Authorization: `Bearer ${installationToken}`,
        },
        signal: controller.signal,
      },
    );

    if (res.status === 200) {
      const data = (await res.json()) as { permission: string };
      return { kind: "permission", value: data.permission };
    }

    if (res.status === 404) {
      return { kind: "absent" };
    }

    return { kind: "error" };
  } catch {
    return { kind: "error" };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Check a user's permission level for a repository via the GitHub App installation token.
 * Thin wrapper over checkUserMembershipStatus: maps `permission` → value, `absent`/`error` → null.
 *
 * @param installationToken - Installation access token from getInstallationAccessToken
 * @param owner - Repository owner
 * @param repo - Repository name
 * @param login - GitHub username to check
 * @param apiBase - GitHub API base URL (default: https://api.github.com)
 * @returns Permission level ("admin", "write", "read", "none") or null on error/absence
 */
export async function checkUserMembership(
  installationToken: string,
  owner: string,
  repo: string,
  login: string,
  apiBase = "https://api.github.com",
): Promise<string | null> {
  const status = await checkUserMembershipStatus(
    installationToken,
    owner,
    repo,
    login,
    apiBase,
  );
  if (status.kind === "permission") {
    return status.value;
  }
  return null;
}
