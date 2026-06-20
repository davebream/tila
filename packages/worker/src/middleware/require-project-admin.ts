import { AdminGrantsStore, D1ProjectRegistry } from "@tila/backend-d1";
import type { MiddlewareHandler } from "hono";
import {
  ADMIN_GRANTS_CACHE_MAX_SIZE,
  ADMIN_GRANTS_CACHE_TTL_MS,
} from "../config";
import type { Env, HonoVariables, UnifiedTokenResult } from "../types";
import { ADMIN_PERMISSION } from "./permission";

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

// --- Per-isolate project auto-admin flag cache (#101) ----------------------
// Caches the `repo_admin_auto_admin` flag per projectId to avoid a D1 read on
// every request that falls through the roster lookup. Mirrors the
// adminGrantsCache above:
//   - TTL expiry on read (stale entries deleted), reusing ADMIN_GRANTS_CACHE_TTL_MS.
//   - Size-capped at ADMIN_GRANTS_CACHE_MAX_SIZE; oldest entry evicted on overflow.
//   - Fail-closed: a D1 error returns false and is NEVER cached; next call re-queries.
//
// Key: projectId — the flag is per-project, not per-user.
const projectAutoAdminCache = new Map<
  string,
  { enabled: boolean; cachedAt: number }
>();

/** Test-only: clear the per-isolate auto-admin flag cache. */
export function __clearProjectAutoAdminCache(): void {
  projectAutoAdminCache.clear();
}

/**
 * Read the cached auto-admin flag for a project. Returns the cached boolean if
 * present and not stale, null on miss or TTL expiry (caller should query D1).
 * Stale entries are deleted on read.
 */
function getProjectAutoAdminFromCache(projectId: string): boolean | null {
  const entry = projectAutoAdminCache.get(projectId);
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > ADMIN_GRANTS_CACHE_TTL_MS) {
    projectAutoAdminCache.delete(projectId);
    return null;
  }
  return entry.enabled;
}

/**
 * Read the `repo_admin_auto_admin` flag from D1 (with per-isolate cache).
 * Fail-closed: any D1 error returns false and is NEVER cached.
 */
async function getProjectAutoAdminCached(
  db: D1Database,
  projectId: string,
): Promise<boolean> {
  const cached = getProjectAutoAdminFromCache(projectId);
  if (cached !== null) return cached;

  let enabled: boolean;
  try {
    const registry = new D1ProjectRegistry(db);
    enabled = await registry.getRepoAdminAutoAdmin(projectId);
  } catch {
    // Fail-closed: error not cached; next call re-queries D1.
    return false;
  }

  // Cache the successful result; insert with oldest-entry eviction on overflow.
  if (
    !projectAutoAdminCache.has(projectId) &&
    projectAutoAdminCache.size >= ADMIN_GRANTS_CACHE_MAX_SIZE
  ) {
    const oldest = projectAutoAdminCache.keys().next().value;
    if (oldest !== undefined) {
      projectAutoAdminCache.delete(oldest);
    }
  }
  projectAutoAdminCache.set(projectId, { enabled, cachedAt: Date.now() });
  return enabled;
}

/**
 * #101 auto-admin: returns true iff the project has opted in (repo_admin_auto_admin)
 * AND the caller is an admin-tier GitHub session (bearer OR cookie). Fail-closed:
 * any non-session kind, any non-"admin" permission, or any D1 error returns false.
 * The flag read is cached per-isolate; errors are never cached.
 *
 * IMPORTANT — discriminated-union narrowing:
 * The kind check is written as EARLY-RETURN guards BEFORE reading `permission`,
 * NOT as a single compound boolean. `permission` is absent on D1TokenResult and
 * WorkspaceSessionTokenResult; TypeScript does not narrow it across a disjunction,
 * so a compound check would not typecheck.
 */
export async function autoAdminGrants(
  db: D1Database,
  tokenResult: UnifiedTokenResult,
  projectId: string,
): Promise<boolean> {
  if (!projectId) return false;
  // Only GitHub sessions carry a normalized permission tier.
  // Bearer ("session") and browser ("cookie-session") are both admitted.
  if (tokenResult.kind !== "session" && tokenResult.kind !== "cookie-session") {
    return false;
  }
  // Only the exact admin tier qualifies — sourced from ADMIN_PERMISSION to keep
  // the tier vocabulary in sync with permission.ts (design D5).
  if (tokenResult.permission !== ADMIN_PERMISSION) return false;
  return getProjectAutoAdminCached(db, projectId);
}

/**
 * Async admin gate for token/repo routes (C5).
 * These routes mount WITHOUT projectMiddleware, so projectId is sourced from
 * tokenResult.projectId (not c.get("projectId"), which is empty on these mounts).
 *
 * Pass paths (return null):
 *   1. d1-token with scopes === "full" — kind-discriminated to avoid misreading
 *      GitHub sessions (which carry scopes: permission) or cookie-sessions
 *      (which may inherit a d1-token's scopes value).
 *   2. autoAdminGrants(db, tokenResult, tokenResult.projectId) — flag-gated
 *      admin-tier session (bearer or cookie).
 *
 * Deny path (return 403 JSON): everything else.
 * AC-2: with the flag off, autoAdminGrants returns false ⇒ only d1-token full-scope
 * passes, byte-identical to the pre-101 baseline.
 */
export async function requireProjectAdminHttp(
  c: import("hono").Context<AdminEnv>,
): Promise<Response | null> {
  const tokenResult = c.get("tokenResult");
  // (1) Kind-discriminated full-scope D1 token check.
  if (tokenResult.kind === "d1-token" && tokenResult.scopes === "full") {
    return null;
  }
  // (2) Flag-gated auto-admin (bearer or cookie-session with admin permission).
  // projectId comes from tokenResult because these routes have no projectMiddleware.
  if (await autoAdminGrants(c.env.DB, tokenResult, tokenResult.projectId)) {
    return null;
  }
  return c.json(
    {
      ok: false,
      error: {
        code: "token-authz-denied",
        message:
          "Repo/token management requires full scope or an admin session",
        retryable: false,
      },
    },
    403,
  );
}

/**
 * Strict inline gate for /api/tokens routes (mint, revoke, list).
 * Returns null (pass) iff the resolved principal is a full-scope D1 API token.
 * All other principals — GitHub sessions (bearer or cookie), workspace sessions,
 * and non-full or absent D1 tokens — receive a 403.
 *
 * Checks `kind === "d1-token"` FIRST (before `scopes`) because cookie-sessions
 * may carry `scopes: "full"` (see the comment in requireProjectAdminHttp above).
 * The `&&` short-circuits on kind, preventing a browser session from slipping
 * through a bare `scopes === "full"` check.
 *
 * Does NOT call autoAdminGrants or read the repo_admin_auto_admin flag —
 * the session allow-path is intentionally removed for token management.
 */
export async function requireD1TokenHttp(
  c: import("hono").Context<AdminEnv>,
): Promise<Response | null> {
  // (1) Defensive: missing/malformed tokenResult ⇒ fail-closed (never throws).
  const tokenResult = c.get("tokenResult");
  if (!tokenResult || typeof tokenResult.kind !== "string") {
    return c.json(
      {
        ok: false,
        error: {
          code: "token-authz-denied",
          message: "Token management requires a full-scope D1 API token",
          retryable: false,
        },
      },
      403,
    );
  }
  // (2) Kind-discriminated strict check — kind MUST come first (see doc above).
  if (tokenResult.kind === "d1-token" && tokenResult.scopes === "full") {
    return null;
  }
  // (3) All other principals denied.
  return c.json(
    {
      ok: false,
      error: {
        code: "token-authz-denied",
        message: "Token management requires a full-scope D1 API token",
        retryable: false,
      },
    },
    403,
  );
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
    // Roster cache HIT — positive: admit immediately (no flag read needed).
    // Roster cache HIT — negative: skip the D1 roster lookup but still try
    //   auto-admin below (the flag is a separate allow path).
    if (cached === true) {
      return next();
    }

    if (cached === null) {
      // Cache miss — query D1 for roster membership.
      let isAdmin: boolean;
      try {
        // Both store construction AND the awaited lookup are inside the try:
        // a throw from either path DENIES and the error is NOT cached.
        const store = new AdminGrantsStore(c.env.DB);
        isAdmin = await store.isActiveAdmin(
          projectId,
          githubHost,
          githubUserId,
        );
      } catch {
        return deny(c);
      }

      setAdminGrantInCache(cacheKey, { isAdmin, cachedAt: Date.now() });

      if (isAdmin) return next();
    }

    // (#101) Roster miss (or cached-false) — try the per-project auto-admin flag.
    if (await autoAdminGrants(c.env.DB, tokenResult, projectId)) return next();
    return deny(c);
  }

  // (3b) Cookie-session → auto-admin only (no roster identity to look up).
  // projectId from c.get("projectId") because projectMiddleware runs at these
  // requireProjectAdmin sites and populates the variable; do NOT use
  // tokenResult.projectId here (that convention is for tokens/repos routes only).
  if (tokenResult.kind === "cookie-session") {
    const cookieProjectId = c.get("projectId");
    if (await autoAdminGrants(c.env.DB, tokenResult, cookieProjectId))
      return next();
    return deny(c);
  }

  // (4) workspace-session, or any other kind → deny.
  return deny(c);
};
