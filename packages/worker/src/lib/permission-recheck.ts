import { GitHubAppConfigStore, RepoAllowlistStore } from "@tila/backend-d1";
import type { Context } from "hono";
import {
  PERMISSION_RECHECK_BACKOFF_MS,
  PERMISSION_RECHECK_CACHE_MAX_SIZE,
  PERMISSION_RECHECK_TTL_MS,
} from "../config";
import type { Env, HonoVariables, SessionTokenResult } from "../types";
import {
  GitHubAppTokenError,
  checkUserMembershipStatus,
  getInstallationAccessToken,
  mintAppJwt,
} from "./github-app";
import {
  PERMISSION_HIERARCHY,
  normalizeGitHubPermission,
} from "./github-permission";

type AppEnv = { Bindings: Env; Variables: HonoVariables };

/**
 * The three settled verdict shapes stored in the per-isolate recheck cache.
 *   - grant:        live GitHub check confirmed sufficient permission
 *   - deny:         live GitHub check confirmed insufficient permission (downgrade/absent)
 *   - not-possible: re-verify is impossible for this project (no App install, secrets absent,
 *                   or App was uninstalled) — Layer A is the backstop
 * A separate "backoff" shape records that a transient error occurred so we don't
 * hammer GitHub on every request during an outage.
 */
type CacheVerdict = "grant" | "deny" | "not-possible";

interface CacheEntry {
  /** The settled verdict (used when backoff is false). */
  verdict?: CacheVerdict;
  /** When true this is a transient-backoff entry (no settled verdict). */
  backoff: boolean;
  /** Millisecond timestamp when the entry was created. */
  cachedAt: number;
}

/**
 * Per-isolate cache keyed by JWT `jti`.
 * Mirrors the jtiRevCache pattern in middleware/auth.ts.
 */
const recheckCache = new Map<string, CacheEntry>();

/**
 * Reset the cache for test isolation.
 * Exported only for unit tests — do not call in production code.
 */
export function _resetPermissionRecheckCacheForTest(): void {
  recheckCache.clear();
}

/**
 * Insert an entry with oldest-entry eviction on overflow.
 */
function setRecheckInCache(jti: string, entry: CacheEntry): void {
  if (
    !recheckCache.has(jti) &&
    recheckCache.size >= PERMISSION_RECHECK_CACHE_MAX_SIZE
  ) {
    const oldest = recheckCache.keys().next().value;
    if (oldest !== undefined) {
      recheckCache.delete(oldest);
    }
  }
  recheckCache.set(jti, entry);
}

/**
 * Read a cache entry for `jti`, respecting TTLs.
 * Returns null on miss or when the entry has expired.
 */
function getRecheckFromCache(jti: string): CacheEntry | null {
  const entry = recheckCache.get(jti);
  if (!entry) return null;

  const now = Date.now();
  const ttl = entry.backoff
    ? PERMISSION_RECHECK_BACKOFF_MS
    : PERMISSION_RECHECK_TTL_MS;

  if (now - entry.cachedAt > ttl) {
    recheckCache.delete(jti);
    return null;
  }
  return entry;
}

/**
 * Re-verify the live GitHub permission for a session bearer on admin/destructive routes.
 *
 * Algorithm (Layer B, WI-H / #131):
 *   1. No jti → skip (pre-C9 token; Layer A backstops) — allow{cacheable:false}.
 *   2. Cache hit → reuse verdict without a GitHub call.
 *   3. App-secrets guard: absent GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY → allow not-possible (cached).
 *   4. getInstallation: null → allow not-possible (cached); throw → deny (fail-closed).
 *   5. isRegistered: null → deny; throw → deny (fail-closed).
 *   6. mintAppJwt + getInstallationAccessToken: 404 throw → allow not-possible (cached);
 *      other throw → allow{cacheable:false} + transient-backoff entry.
 *   7. checkUserMembershipStatus:
 *        permission ≥ required → allow grant (cached)
 *        permission < required → deny (cached)
 *        absent               → deny (cached)
 *        error                → allow{cacheable:false} + transient-backoff entry
 *
 * Posture split: internal D1 reads fail CLOSED (deny); only the external GitHub
 * round-trip fails OPEN (allow on transient), with a transient-backoff entry to
 * prevent hammering GitHub under an outage.
 *
 * GHES note: tila is github.com-only in v1. The apiBase is derived from
 * session.githubHost so GHES support is wired structurally but untested.
 * Follow-up: validate against a GHES instance when needed.
 *
 * @param c - Hono context (must have c.env)
 * @param session - SessionTokenResult (kind:"session") from auth middleware
 * @param required - Permission level the route requires ("read" | "write" | "admin")
 */
export async function reverifySessionPermission(
  c: Context<AppEnv>,
  session: SessionTokenResult,
  required: "read" | "write" | "admin",
): Promise<
  | { decision: "allow"; cacheable: boolean }
  | { decision: "deny"; reason: string }
> {
  // Step 1: no jti — pre-C9 token, skip re-verify; Layer A applies.
  if (!session.jti) {
    return { decision: "allow", cacheable: false };
  }

  const jti = session.jti;

  // Step 2: cache lookup.
  const cached = getRecheckFromCache(jti);
  if (cached !== null) {
    if (cached.backoff) {
      // Transient-backoff entry: allow without caching a positive (same as original)
      return { decision: "allow", cacheable: false };
    }
    // Settled entry
    if (cached.verdict === "grant" || cached.verdict === "not-possible") {
      return { decision: "allow", cacheable: true };
    }
    if (cached.verdict === "deny") {
      return {
        decision: "deny",
        reason: "Permission re-check: access was revoked or downgraded",
      };
    }
  }

  // Step 3: App-secrets guard.
  if (!c.env.GITHUB_APP_ID || !c.env.GITHUB_APP_PRIVATE_KEY) {
    setRecheckInCache(jti, {
      verdict: "not-possible",
      backoff: false,
      cachedAt: Date.now(),
    });
    return { decision: "allow", cacheable: true };
  }

  // Step 4: Resolve App installation — fail CLOSED on D1 error.
  let installation: { installation_id: number } | null;
  try {
    installation = await new GitHubAppConfigStore(c.env.DB).getInstallation(
      session.projectId,
    );
  } catch {
    return {
      decision: "deny",
      reason: "Permission re-check: re-check unavailable (D1 error)",
    };
  }

  if (!installation) {
    setRecheckInCache(jti, {
      verdict: "not-possible",
      backoff: false,
      cachedAt: Date.now(),
    });
    return { decision: "allow", cacheable: true };
  }

  // Step 5: Resolve owner/repo from allowlist — fail CLOSED on D1 error or missing row.
  const host = session.githubHost ?? "github.com";
  let repoRow: { github_owner: string; github_repo: string } | null;
  try {
    repoRow = await new RepoAllowlistStore(c.env.DB).isRegistered(
      session.projectId,
      host,
      session.githubRepoId,
    );
  } catch {
    return {
      decision: "deny",
      reason:
        "Permission re-check: re-check unavailable (D1 error on repo lookup)",
    };
  }

  if (!repoRow) {
    setRecheckInCache(jti, {
      verdict: "deny",
      backoff: false,
      cachedAt: Date.now(),
    });
    return {
      decision: "deny",
      reason: "Permission re-check: repo no longer registered",
    };
  }

  const { github_owner: owner, github_repo: repo } = repoRow;

  // Derive apiBase from host (GHES-ready but github.com-only in v1).
  const apiBase =
    host === "github.com" ? "https://api.github.com" : `https://${host}/api/v3`;

  // Step 6: Mint App installation token.
  let installationToken: string;
  try {
    const appJwt = await mintAppJwt(
      Number(c.env.GITHUB_APP_ID),
      c.env.GITHUB_APP_PRIVATE_KEY,
    );
    installationToken = await getInstallationAccessToken(
      appJwt,
      installation.installation_id,
      apiBase,
    );
  } catch (err) {
    if (err instanceof GitHubAppTokenError && err.status === 404) {
      // App was uninstalled — permanent not-possible; cache it.
      setRecheckInCache(jti, {
        verdict: "not-possible",
        backoff: false,
        cachedAt: Date.now(),
      });
      return { decision: "allow", cacheable: true };
    }
    // Other error (5xx / network) — transient, fail open + write backoff entry.
    setRecheckInCache(jti, { backoff: true, cachedAt: Date.now() });
    return { decision: "allow", cacheable: false };
  }

  // Step 7: Check current membership.
  const status = await checkUserMembershipStatus(
    installationToken,
    owner,
    repo,
    session.githubLogin,
    apiBase,
  );

  if (status.kind === "permission") {
    const currentNorm = normalizeGitHubPermission(status.value);
    const currentLevel = PERMISSION_HIERARCHY[currentNorm] ?? 0;
    const requiredLevel = PERMISSION_HIERARCHY[required] ?? 0;

    if (currentLevel >= requiredLevel) {
      setRecheckInCache(jti, {
        verdict: "grant",
        backoff: false,
        cachedAt: Date.now(),
      });
      return { decision: "allow", cacheable: true };
    }

    setRecheckInCache(jti, {
      verdict: "deny",
      backoff: false,
      cachedAt: Date.now(),
    });
    return {
      decision: "deny",
      reason: "Permission re-check: permission downgraded since session issued",
    };
  }

  if (status.kind === "absent") {
    setRecheckInCache(jti, {
      verdict: "deny",
      backoff: false,
      cachedAt: Date.now(),
    });
    return {
      decision: "deny",
      reason: "Permission re-check: collaborator access revoked",
    };
  }

  // kind === "error" — transient, fail open + write backoff entry.
  setRecheckInCache(jti, { backoff: true, cachedAt: Date.now() });
  return { decision: "allow", cacheable: false };
}
