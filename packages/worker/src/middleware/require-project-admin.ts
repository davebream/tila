import { AdminGrantsStore } from "@tila/backend-d1";
import type { MiddlewareHandler } from "hono";
import {
  ADMIN_GRANTS_CACHE_MAX_SIZE,
  ADMIN_GRANTS_CACHE_TTL_MS,
} from "../config";
import type { Env, HonoVariables } from "../types";

// AdminEnv is declared LOCALLY here, not imported from routes/admin.ts: the
// middleware must not depend on the route module (that would invert the
// middleware → route dependency).
type AdminEnv = { Bindings: Env; Variables: HonoVariables };

// --- Per-isolate admin-grants roster cache ---------------------------------
// Caches roster-membership results to avoid a D1 read on every bearer-session
// request. Mirrors the jti revocation cache in auth.ts:
//   - Entries expire after ADMIN_GRANTS_CACHE_TTL_MS (TTL expiry on read).
//   - Size-capped at ADMIN_GRANTS_CACHE_MAX_SIZE; oldest entry evicted on overflow.
//   - Fail-closed: a D1 lookup error DENIES and is NEVER cached (a second call
//     within the TTL re-queries D1).
//
// Key: `${projectId}:${githubHost}:${githubUserId}` — projectId is part of the
// key so a positive entry for one project can never satisfy another.
const adminGrantsCache = new Map<
  string,
  { isAdmin: boolean; cachedAt: number }
>();

/** Insert into the cache with oldest-entry eviction on overflow. */
function setAdminGrantInCache(
  key: string,
  entry: { isAdmin: boolean; cachedAt: number },
): void {
  if (
    !adminGrantsCache.has(key) &&
    adminGrantsCache.size >= ADMIN_GRANTS_CACHE_MAX_SIZE
  ) {
    const oldest = adminGrantsCache.keys().next().value;
    if (oldest !== undefined) {
      adminGrantsCache.delete(oldest);
    }
  }
  adminGrantsCache.set(key, entry);
}

/**
 * Read the cache. Returns the cached `isAdmin` boolean if present and not
 * stale; returns `null` (caller should query D1) on miss or TTL expiry.
 * Stale entries are deleted on read.
 */
function getAdminGrantFromCache(key: string): boolean | null {
  const entry = adminGrantsCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > ADMIN_GRANTS_CACHE_TTL_MS) {
    adminGrantsCache.delete(key);
    return null;
  }
  return entry.isAdmin;
}

/** Test-only: clear the per-isolate cache (mirrors the jti cache reset surface). */
export function __clearAdminGrantsCache(): void {
  adminGrantsCache.clear();
}

/**
 * Immediately evict a specific admin-grants cache entry (true purge — `delete`,
 * NOT a flag-set). Called by the DELETE /admins/:githubUserId route so the
 * revoking isolate denies the de-admined user without waiting for TTL expiry.
 *
 * Security note: the cache stores `{ isAdmin: true|false }` where `true` means
 * ALLOW. Using `delete` ensures the next request re-queries D1 (which now
 * returns false after `AdminGrantsStore.revoke`). A set-to-false would NOT
 * grant admin for the TTL; however, delete is the correct semantics because it
 * guarantees a fresh D1 round-trip regardless of what revoke produced.
 */
export function revokeAdminGrantInCache(cacheKey: string): void {
  adminGrantsCache.delete(cacheKey);
}

function deny(c: Parameters<MiddlewareHandler<AdminEnv>>[0]) {
  return c.json(
    {
      ok: false,
      error: {
        code: "permission-denied",
        message: "Project admin required",
        retryable: false,
      },
    },
    403,
  );
}

/**
 * Authorization gate for project-admin routes.
 *
 * Mounted AFTER auth + project middleware. Branches, in order:
 *   1. Defensive: no tokenResult / unknown kind → deny (fail-closed, never throws).
 *   2. d1-token with scopes === "full" → pass (no roster lookup).
 *   3. bearer session → cached roster lookup (fail-closed on D1 error).
 *   4. anything else (cookie-session, workspace-session) → deny.
 */
export const requireProjectAdmin: MiddlewareHandler<AdminEnv> = async (
  c,
  next,
) => {
  const tokenResult = c.get("tokenResult");

  // (1) Defensive: missing tokenResult → fail-closed.
  if (!tokenResult || typeof tokenResult.kind !== "string") {
    return deny(c);
  }

  // (2) Full-scope D1 token is project-admin unconditionally. MUST check
  // scopes === "full" (not kind alone) — a non-full D1 token is not admin.
  if (tokenResult.kind === "d1-token") {
    if (tokenResult.scopes === "full") {
      return next();
    }
    return deny(c);
  }

  // (3) Bearer GitHub session → roster lookup against _admin_grants.
  if (tokenResult.kind === "session") {
    const githubUserId = tokenResult.githubUserId;
    const githubHost = tokenResult.githubHost;
    const projectId = c.get("projectId");

    // Null-identity / missing-project guard — fail-closed before any lookup.
    if (githubUserId == null || githubHost == null || !projectId) {
      return deny(c);
    }

    // host must be canonical across grant + mint paths; #98 is github.com-only —
    // defer GHES normalization (follow-up).
    const cacheKey = `${projectId}:${githubHost}:${githubUserId}`;
    const cached = getAdminGrantFromCache(cacheKey);
    if (cached !== null) {
      return cached ? next() : deny(c);
    }

    let isAdmin: boolean;
    try {
      // Both store construction AND the awaited lookup are inside the try:
      // a throw from either path DENIES and the error is NOT cached.
      const store = new AdminGrantsStore(c.env.DB);
      isAdmin = await store.isActiveAdmin(projectId, githubHost, githubUserId);
    } catch {
      return deny(c);
    }

    setAdminGrantInCache(cacheKey, { isAdmin, cachedAt: Date.now() });

    // Extension point (#101): a repo-admin auto-admin branch would slot in here,
    // granting admin to GitHub repo-admins even without an explicit roster grant.
    // Not built — no `autoAdmin` config exists yet.
    return isAdmin ? next() : deny(c);
  }

  // (4) cookie-session, workspace-session, or any other kind → deny.
  return deny(c);
};
