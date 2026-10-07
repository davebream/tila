import {
  GitHubAppConfigStore,
  type RepoAllowlistRow,
  RepoAllowlistStore,
} from "@tila/backend-d1";
import {
  ProjectRoleSchema,
  type SessionPermission,
  roleToPermission,
} from "@tila/schemas";
import type { Context } from "hono";
import {
  PERMISSION_RECHECK_BACKOFF_MS,
  PERMISSION_RECHECK_CACHE_MAX_SIZE,
  PERMISSION_RECHECK_TTL_MS,
} from "../config";
import type {
  CookieSessionTokenResult,
  Env,
  HonoVariables,
  SessionTokenResult,
} from "../types";
import {
  GitHubAppTokenError,
  checkUserMembershipStatus,
  getInstallationAccessToken,
  mintAppJwt,
} from "./github-app";
import {
  evaluateRepositoryAccess,
  permissionMeetsRequirement,
} from "./repo-access-policy";

type AppEnv = { Bindings: Env; Variables: HonoVariables };
export type PermissionRecheckFailure = {
  decision: "deny";
  status: 401 | 403 | 503;
  code:
    | "unauthorized"
    | "permission-revoked"
    | "permission-recheck-unavailable";
  reason: string;
  retryable: boolean;
};
export type PermissionRecheckResult =
  | { decision: "allow"; cacheable: boolean }
  | PermissionRecheckFailure;

type CacheEntry = { cachedAt: number } & (
  | { kind: "verified-grant"; githubPermission: string }
  | { kind: "verified-deny"; failure: PermissionRecheckFailure }
  | { kind: "unavailable"; failure: PermissionRecheckFailure }
  | { kind: "transient-error"; failure: PermissionRecheckFailure }
);
const recheckCache = new Map<string, CacheEntry>();

/** Test-only cache reset. Production entries expire per isolate. */
export function _resetPermissionRecheckCacheForTest(): void {
  recheckCache.clear();
}

function setRecheckInCache(key: string, entry: CacheEntry): void {
  if (
    !recheckCache.has(key) &&
    recheckCache.size >= PERMISSION_RECHECK_CACHE_MAX_SIZE
  ) {
    const oldest = recheckCache.keys().next().value;
    if (oldest !== undefined) recheckCache.delete(oldest);
  }
  recheckCache.set(key, entry);
}

function getRecheckFromCache(key: string): CacheEntry | null {
  const entry = recheckCache.get(key);
  if (!entry) return null;
  const ttl =
    entry.kind === "transient-error"
      ? PERMISSION_RECHECK_BACKOFF_MS
      : PERMISSION_RECHECK_TTL_MS;
  if (Date.now() - entry.cachedAt >= ttl) {
    recheckCache.delete(key);
    return null;
  }
  return entry;
}

function unavailable(
  reason: string,
  retryable: boolean,
): PermissionRecheckFailure {
  return {
    decision: "deny",
    status: 503,
    code: "permission-recheck-unavailable",
    reason,
    retryable,
  };
}
function revoked(reason: string): PermissionRecheckFailure {
  return {
    decision: "deny",
    status: 403,
    code: "permission-revoked",
    reason,
    retryable: false,
  };
}

/** Apply today's policy to the cached GitHub observation, never a cached Tila grant. */
function evaluatePermission(
  repo: RepoAllowlistRow,
  permission: string,
  required: SessionPermission,
): PermissionRecheckResult {
  const access = evaluateRepositoryAccess(repo, permission);
  const cap = ProjectRoleSchema.safeParse(repo.membership_role_cap);
  if (
    !access ||
    !cap.success ||
    cap.data === "owner" ||
    repo.membership_enabled !== 1 ||
    !permissionMeetsRequirement(access.permission, required) ||
    !permissionMeetsRequirement(roleToPermission(cap.data), required)
  ) {
    return revoked(
      "Repository permission downgraded or policy cap is insufficient",
    );
  }
  return { decision: "allow", cacheable: true };
}

/**
 * Protected operations never fall back to session authority when verification fails.
 * Configuration, installation and policy are checked before cached GitHub observations.
 * Explicit membership bypass belongs to the shared operation guard, not this verifier.
 */
export async function reverifySessionPermission(
  c: Context<AppEnv>,
  session: SessionTokenResult | CookieSessionTokenResult,
  required: SessionPermission,
): Promise<PermissionRecheckResult> {
  const cookieIdentity =
    session.kind === "cookie-session"
      ? /^github:([^:]+):(\d+)$/.exec(session.principalId ?? "")
      : null;
  const credential =
    session.kind === "session" ? session.jti : session.sessionHash;
  const host =
    session.kind === "session"
      ? (session.githubHost ?? "github.com")
      : cookieIdentity?.[1];
  const subject =
    session.kind === "session"
      ? session.githubUserId
      : Number(cookieIdentity?.[2]);
  const repoId =
    session.kind === "session" ? session.githubRepoId : session.sourceRepoId;
  const login = session.kind === "session" ? session.githubLogin : session.name;
  if (!credential || !host || !subject || !repoId || !login) {
    return {
      decision: "deny",
      status: 401,
      code: "unauthorized",
      reason: "Session has no verifiable repository identity; sign in again.",
      retryable: false,
    };
  }
  const appId = Number(c.env.GITHUB_APP_ID);
  if (
    !Number.isSafeInteger(appId) ||
    appId <= 0 ||
    !c.env.GITHUB_APP_PRIVATE_KEY
  ) {
    return unavailable(
      "Configure GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY to verify mirrored permissions.",
      false,
    );
  }

  let installation: { installation_id: number } | null;
  let repo: RepoAllowlistRow | null;
  try {
    installation = await new GitHubAppConfigStore(c.env.DB).getInstallation(
      session.projectId,
    );
    repo = await new RepoAllowlistStore(c.env.DB).isRegistered(
      session.projectId,
      host,
      repoId,
    );
  } catch {
    return unavailable(
      "Permission re-check unavailable (D1 error); retry the request.",
      true,
    );
  }
  if (!installation)
    return unavailable(
      "Install and link the GitHub App for this project to verify mirrored permissions.",
      false,
    );
  if (!repo || repo.membership_enabled !== 1)
    return revoked(
      "Repository is no longer registered or its membership adapter is disabled",
    );

  // A credential rotation must invalidate observations made with the previous App key.
  const configDigest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(c.env.GITHUB_APP_PRIVATE_KEY),
  );
  const configKey = Array.from(new Uint8Array(configDigest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  const key = JSON.stringify([
    session.kind,
    credential,
    session.projectId,
    host,
    subject,
    login,
    repoId,
    installation.installation_id,
    appId,
    configKey,
  ]);
  const cached = getRecheckFromCache(key);
  if (cached) {
    return cached.kind === "verified-grant"
      ? evaluatePermission(repo, cached.githubPermission, required)
      : cached.failure;
  }
  const saveFailure = (
    kind: "verified-deny" | "unavailable" | "transient-error",
    failure: PermissionRecheckFailure,
  ) => {
    setRecheckInCache(key, { kind, failure, cachedAt: Date.now() });
    return failure;
  };
  let appJwt: string;
  try {
    appJwt = await mintAppJwt(appId, c.env.GITHUB_APP_PRIVATE_KEY);
  } catch {
    return saveFailure(
      "unavailable",
      unavailable(
        "Repair the GitHub App ID/private key configuration to verify mirrored permissions.",
        false,
      ),
    );
  }
  const apiBase =
    host === "github.com" ? "https://api.github.com" : `https://${host}/api/v3`;
  let installationToken: string;
  try {
    installationToken = await getInstallationAccessToken(
      appJwt,
      installation.installation_id,
      apiBase,
    );
  } catch (error) {
    if (error instanceof GitHubAppTokenError && error.status === 404) {
      return saveFailure(
        "unavailable",
        unavailable(
          "GitHub App installation is unavailable; reinstall and relink the App for this project.",
          false,
        ),
      );
    }
    if (error instanceof GitHubAppTokenError && error.status === 401) {
      return saveFailure(
        "unavailable",
        unavailable(
          "GitHub rejected the App credentials; repair the GitHub App configuration.",
          false,
        ),
      );
    }
    return saveFailure(
      "transient-error",
      unavailable(
        "GitHub permission verification is temporarily unavailable; retry the request.",
        true,
      ),
    );
  }
  const status = await checkUserMembershipStatus(
    installationToken,
    repo.github_owner,
    repo.github_repo,
    login,
    apiBase,
  );
  if (status.kind === "permission") {
    setRecheckInCache(key, {
      kind: "verified-grant",
      githubPermission: status.value,
      cachedAt: Date.now(),
    });
    return evaluatePermission(repo, status.value, required);
  }
  if (status.kind === "absent")
    return saveFailure(
      "verified-deny",
      revoked("Repository collaborator access was revoked"),
    );
  return saveFailure(
    "transient-error",
    unavailable(
      "GitHub permission verification is temporarily unavailable; retry the request.",
      true,
    ),
  );
}

export function permissionRecheckResponse(
  c: Context<AppEnv>,
  failure: PermissionRecheckFailure,
): Response {
  return c.json(
    {
      ok: false,
      error: {
        code: failure.code,
        message: failure.reason,
        retryable: failure.retryable,
      },
    },
    failure.status,
  );
}
