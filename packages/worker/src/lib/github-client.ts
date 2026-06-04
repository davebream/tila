import { GITHUB_API_TIMEOUT_MS } from "../config";
import { githubFetch } from "./github-fetch";

/**
 * Exchange a GitHub OAuth authorization code for an access token.
 *
 * @param clientId - GitHub OAuth App client ID
 * @param clientSecret - GitHub OAuth App client secret
 * @param code - Authorization code from the OAuth callback
 * @param redirectUri - Redirect URI used in the authorization request
 * @returns Object containing the access token
 * @throws on non-200 response or GitHub error response
 */
export async function exchangeOAuthCode(
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
): Promise<{ accessToken: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GITHUB_API_TIMEOUT_MS);
  try {
    const res = await githubFetch(
      "https://github.com/login/oauth/access_token",
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          client_id: clientId,
          client_secret: clientSecret,
          code,
          redirect_uri: redirectUri,
        }),
        signal: controller.signal,
      },
    );
    if (!res.ok)
      throw new Error(`GitHub OAuth token exchange failed: ${res.status}`);
    const data = (await res.json()) as {
      access_token?: string;
      error?: string;
    };
    if (data.error || !data.access_token) {
      throw new Error(`GitHub OAuth error: ${data.error ?? "no access_token"}`);
    }
    return { accessToken: data.access_token };
  } finally {
    clearTimeout(timeout);
  }
}

export interface GitHubUser {
  login: string;
  id: number;
}

/**
 * Get the authenticated GitHub user.
 * Returns user info or throws on non-200.
 * The githubToken parameter is NEVER logged.
 */
export async function getAuthenticatedUser(
  githubToken: string,
  apiBase = "https://api.github.com",
): Promise<GitHubUser> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GITHUB_API_TIMEOUT_MS);

  try {
    const res = await githubFetch(`${apiBase}/user`, {
      headers: {
        Authorization: `Bearer ${githubToken}`,
      },
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`GitHub API returned ${res.status}`);
    }

    const data = (await res.json()) as { login: string; id: number };
    return { login: data.login, id: data.id };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Get repository metadata (id, full_name) by owner/repo.
 * Returns a result object instead of throwing, so the caller can map
 * HTTP status codes (404 -> REPO_NOT_FOUND, 403 -> REPO_ACCESS_DENIED).
 *
 * The githubToken parameter, if non-empty, is used as Bearer auth.
 * It is NEVER logged.
 */
export async function getRepoMetadata(
  githubToken: string,
  owner: string,
  repo: string,
  apiBase = "https://api.github.com",
): Promise<{ ok: boolean; status: number; id?: number; full_name?: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GITHUB_API_TIMEOUT_MS);

  try {
    const headers: Record<string, string> = {};
    if (githubToken) {
      headers.Authorization = `Bearer ${githubToken}`;
    }

    const res = await githubFetch(`${apiBase}/repos/${owner}/${repo}`, {
      headers,
      signal: controller.signal,
    });

    if (!res.ok) {
      return { ok: false, status: res.status };
    }

    const data = (await res.json()) as { id: number; full_name: string };
    return { ok: true, status: 200, id: data.id, full_name: data.full_name };
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      return { ok: false, status: 504 };
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Get a user's permission level for a specific repo.
 * Returns the permission string ("admin", "write", "read", "none") or null on error.
 * The githubToken parameter is NEVER logged.
 */
export async function getRepoPermission(
  githubToken: string,
  owner: string,
  repo: string,
  login: string,
  apiBase = "https://api.github.com",
): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GITHUB_API_TIMEOUT_MS);

  try {
    const res = await githubFetch(
      `${apiBase}/repos/${owner}/${repo}/collaborators/${login}/permission`,
      {
        headers: {
          Authorization: `Bearer ${githubToken}`,
        },
        signal: controller.signal,
      },
    );

    if (!res.ok) {
      return null;
    }

    const data = (await res.json()) as { permission: string };
    return data.permission ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
