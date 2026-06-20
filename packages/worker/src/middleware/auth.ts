import {
  D1RateLimitStore,
  D1RevokedJtiStore,
  D1SessionStore,
  D1TokenStore,
  type RateLimitStoreInterface,
} from "@tila/backend-d1";
import { SessionPayloadSchema } from "@tila/schemas";
import type { MiddlewareHandler } from "hono";
import { importJWK, jwtVerify } from "jose";
import {
  DEBOUNCE_MS,
  ISOLATE_RL_MAX_FAILURES,
  ISOLATE_RL_MAX_MAP_SIZE,
  JTI_REVCHECK_TTL_MS,
  JTI_REV_CACHE_MAX_SIZE,
  MAX_DEBOUNCE_MAP_SIZE,
  RATE_LIMIT_MAX_FAILURES,
  RATE_LIMIT_WINDOW_MS,
} from "../config";
import { base64UrlDecode, base64UrlEncode } from "../lib/base64url";
import { hashToken } from "../lib/hash-token";
import { parseCookieHeader } from "../lib/parse-cookie";
import {
  getSessionFromCache,
  invalidateSession,
  setSessionInCache,
} from "../lib/session-cache";
import { type TokenClaims, getFromCache, setInCache } from "../lib/token-cache";
import type {
  CookieSessionTokenResult,
  D1TokenResult,
  Env,
  HonoVariables,
  SessionTokenResult,
  WorkspaceSessionTokenResult,
} from "../types";

// --- Re-export invalidate for T3 revoke handler convenience ---
export { invalidate } from "../lib/token-cache";

// --- Debounce state ---
const lastWriteMap = new Map<string, number>();

// --- SEC-1: HASH_PEPPER unset warning (once per isolate) ---
// When HASH_PEPPER is not configured, token/session hashes fall back to bare
// SHA-256 (see lib/hash-token.ts). That is a valid default, but an operator who
// believes peppering is active should get a signal that it is not. We emit a
// single log + Analytics datapoint per isolate on the first request handled by
// the auth middleware (regardless of auth outcome) so the warning is visible
// without spamming every request.
let hashPepperUnsetWarned = false;

/**
 * Warn exactly once per isolate when HASH_PEPPER is unset. No-op when the pepper
 * is configured. Analytics emission is best-effort and never load-bearing.
 */
function warnHashPepperUnsetOnce(env: Env): void {
  if (hashPepperUnsetWarned || env.HASH_PEPPER) return;
  hashPepperUnsetWarned = true;
  console.warn(
    "[auth] HASH_PEPPER is not set — token and session hashes use bare SHA-256. " +
      "Set the HASH_PEPPER secret to harden stored hashes (HMAC-SHA-256). " +
      "Note: enabling it does not re-hash existing credentials (code: hash-pepper-unset).",
  );
  try {
    env.ANALYTICS.writeDataPoint({
      blobs: ["auth", "hash-pepper-unset"],
      doubles: [1],
      indexes: ["hash-pepper-unset"],
    });
  } catch {
    // Analytics emission is never load-bearing
  }
}

// --- In-isolate sliding-window rate-limit fallback (C8) ---
// When D1's rate-limit check throws (fail-open), we consult this in-isolate
// counter as a secondary guard. Best-effort and per-isolate (not global), but
// hardens against D1 blips that would otherwise leave the endpoint wide open.
//
// Map<ip, timestamps[]> — each entry is an array of Unix-ms timestamps within
// the current window. Pruned to RATE_LIMIT_WINDOW_MS on every access.
// Size-capped at ISOLATE_RL_MAX_MAP_SIZE (evicts oldest entry on overflow).
const isolateFailMap = new Map<string, number[]>();

/**
 * Record a D1-fail-open failure for `ip` in the per-isolate sliding window.
 * Evicts the oldest IP entry if the map has grown past ISOLATE_RL_MAX_MAP_SIZE.
 * Not exported — internal to the auth middleware region.
 */
function isolateRecordFailure(ip: string): void {
  const now = Date.now();
  const existing = isolateFailMap.get(ip);
  const windowStart = now - RATE_LIMIT_WINDOW_MS;

  if (!existing) {
    // Cap map size: evict oldest entry before inserting a new one
    if (isolateFailMap.size >= ISOLATE_RL_MAX_MAP_SIZE) {
      const oldest = isolateFailMap.keys().next().value;
      if (oldest !== undefined) {
        isolateFailMap.delete(oldest);
      }
    }
    isolateFailMap.set(ip, [now]);
  } else {
    // Prune entries outside the window, then append
    const pruned = existing.filter((t) => t > windowStart);
    pruned.push(now);
    isolateFailMap.set(ip, pruned);
  }
}

/**
 * Return true if `ip` has exceeded ISOLATE_RL_MAX_FAILURES within the window.
 * Also prunes the window in place. Not exported.
 */
function isolateIsLimited(ip: string): boolean {
  const now = Date.now();
  const windowStart = now - RATE_LIMIT_WINDOW_MS;
  const entries = isolateFailMap.get(ip);
  if (!entries) return false;
  const pruned = entries.filter((t) => t > windowStart);
  if (pruned.length !== entries.length) {
    isolateFailMap.set(ip, pruned);
  }
  return pruned.length >= ISOLATE_RL_MAX_FAILURES;
}

// --- HMAC CryptoKey cache (per-isolate, single-slot) ---
// jose's jwtVerify accepts a CryptoKey; we keep the cache to avoid redundant importKey calls.
let cachedHmacKey: CryptoKey | null = null;
let cachedHmacKeyRaw: string | null = null;

// --- Per-isolate jti revocation status cache (C9) ---
// Caches revocation-check results to avoid a D1 read on every session-bearer request.
//
// Security contract (documented in design C9):
//   - Revocation is effective within at most JTI_REVCHECK_TTL_MS across isolates.
//   - The revoking isolate invalidates its own cache entry immediately (see revokeJtiInCache).
//   - If the D1 lookup errors, the request is DENIED (fail-closed) — the cache is not
//     consulted as a fallback in the error path.
//
// Map<jti, { revoked: boolean; cachedAt: number }>
// Entries are evicted after JTI_REVCHECK_TTL_MS milliseconds (TTL expiry in getJtiFromCache).
// Size-capped at JTI_REV_CACHE_MAX_SIZE; oldest entry evicted on overflow (same pattern
// as isolateFailMap and lastWriteMap — all per-isolate maps are bounded).
const jtiRevCache = new Map<string, { revoked: boolean; cachedAt: number }>();

/**
 * Insert a jti into the revocation cache with oldest-entry eviction on overflow.
 * Internal helper used by both revokeJtiInCache and the D1 lookup path.
 */
function setJtiInCache(
  jti: string,
  entry: { revoked: boolean; cachedAt: number },
): void {
  if (!jtiRevCache.has(jti) && jtiRevCache.size >= JTI_REV_CACHE_MAX_SIZE) {
    const oldest = jtiRevCache.keys().next().value;
    if (oldest !== undefined) {
      jtiRevCache.delete(oldest);
    }
  }
  jtiRevCache.set(jti, entry);
}

/**
 * Immediately mark a jti as revoked in the per-isolate cache.
 * Called by the revoke route so the revoking isolate takes effect instantly.
 * Exported for use by the admin revoke route handler.
 */
export function revokeJtiInCache(jti: string): void {
  setJtiInCache(jti, { revoked: true, cachedAt: Date.now() });
}

/**
 * Check the per-isolate jti revocation cache.
 * Returns `true` if the entry is cached as revoked and not stale.
 * Returns `false` if cached as not-revoked and not stale.
 * Returns `null` (cache miss or stale) if the caller should query D1.
 */
function getJtiFromCache(jti: string): boolean | null {
  const entry = jtiRevCache.get(jti);
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > JTI_REVCHECK_TTL_MS) {
    jtiRevCache.delete(jti);
    return null;
  }
  return entry.revoked;
}

function isExpectedAudience(aud: unknown, expected: string): boolean {
  // Fail closed: an absent aud is not an expected audience. The session-token
  // call site already guards `aud === undefined` separately, so this is
  // defense-in-depth should a future caller drop that outer guard.
  if (aud === undefined) return false;
  return Array.isArray(aud) ? aud.includes(expected) : aud === expected;
}

async function getHmacKey(rawKey: string): Promise<CryptoKey> {
  if (cachedHmacKeyRaw === rawKey && cachedHmacKey) {
    return cachedHmacKey;
  }
  const keyBytes = base64UrlDecode(rawKey);
  const key = (await importJWK(
    { kty: "oct", k: base64UrlEncode(keyBytes), alg: "HS256" },
    "HS256",
  )) as CryptoKey;
  cachedHmacKeyRaw = rawKey;
  cachedHmacKey = key;
  return key;
}

// --- Session result builder (shared between cache-hit and D1-fallback paths) ---
function buildSessionTokenResult(
  sessionHash: string,
  cached: {
    projectId: string;
    name: string;
    scopes: string;
    expiresAt: number;
    permission?: string;
  },
): {
  tokenResult: WorkspaceSessionTokenResult | CookieSessionTokenResult;
  authKind: "workspace" | "cookie";
} {
  if (cached.projectId === "") {
    return {
      tokenResult: {
        kind: "workspace-session",
        projectId: "",
        name: cached.name,
        scopes: "",
        tokenId: "",
        sessionHash,
        githubLogin: cached.name,
        expiresAt: cached.expiresAt,
      } satisfies WorkspaceSessionTokenResult,
      authKind: "workspace",
    };
  }
  return {
    tokenResult: {
      kind: "cookie-session",
      projectId: cached.projectId,
      name: cached.name,
      scopes: cached.scopes,
      tokenId: "",
      sessionHash,
      expiresAt: cached.expiresAt,
      permission: cached.permission ?? "read",
    } satisfies CookieSessionTokenResult,
    authKind: "cookie",
  };
}

// --- IP extraction (injectable for testing) ---
export type GetClientIP = (req: Request) => string | null;
export const defaultGetClientIP: GetClientIP = (req) =>
  req.headers.get("CF-Connecting-IP");

/**
 * Create the auth middleware factory.
 * @param opts.getClientIP - Override IP extraction for tests (default: CF-Connecting-IP)
 * @param opts.rateLimitStore - Override rate limit store for tests (default: D1RateLimitStore)
 */
export function createAuthMiddleware(
  opts: {
    getClientIP?: GetClientIP;
    rateLimitStore?: RateLimitStoreInterface;
  } = {},
): MiddlewareHandler<{ Bindings: Env; Variables: HonoVariables }> {
  const getIP = opts.getClientIP ?? defaultGetClientIP;

  return async (c, next) => {
    const now = Date.now();

    // SEC-1: warn once per isolate if HASH_PEPPER is unset (bare SHA-256 fallback).
    warnHashPepperUnsetOnce(c.env);

    // 1. Rate limit check (pre-auth)
    const ip = getIP(c.req.raw);
    if (ip) {
      const store = opts.rateLimitStore ?? new D1RateLimitStore(c.env.DB);
      try {
        const isLimited = await store.check(
          ip,
          RATE_LIMIT_MAX_FAILURES,
          RATE_LIMIT_WINDOW_MS,
        );
        if (isLimited) {
          return c.json(
            {
              ok: false,
              error: {
                code: "rate-limited",
                message: "Too many failed authentication attempts",
                retryable: true,
              },
            },
            429,
          );
        }
      } catch {
        // Fail open — D1 transient error should not block legitimate users.
        // Secondary guard: consult the per-isolate sliding-window counter.
        // If this IP has seen ISOLATE_RL_MAX_FAILURES D1-fail-open events within
        // the window, return 429 as a defense-in-depth measure.
        isolateRecordFailure(ip);
        if (isolateIsLimited(ip)) {
          return c.json(
            {
              ok: false,
              error: {
                code: "rate-limited",
                message: "Too many failed authentication attempts",
                retryable: true,
              },
            },
            429,
          );
        }
        try {
          c.env.ANALYTICS.writeDataPoint({
            blobs: ["auth", "rate_limit_d1_error", "check"],
            doubles: [1],
            indexes: ["rate-limit"],
          });
        } catch {
          // Analytics emission is never load-bearing
        }
      }
    }

    // 1.5: Cookie-session branch (before Bearer check)
    const sessionCookie = parseCookieHeader(
      c.req.header("Cookie"),
      "tila_session",
    );
    if (sessionCookie) {
      const sessionHash = await hashToken(sessionCookie, c.env.HASH_PEPPER);
      const cached = getSessionFromCache(sessionHash);

      if (cached === false) {
        // Negative cache hit — deny without hitting D1 or recording rate-limit
        return c.json(
          {
            ok: false,
            error: {
              code: "session-expired",
              message: "Session cookie is invalid or expired",
              retryable: false,
            },
          },
          401,
        );
      }

      let sessionResult: Awaited<ReturnType<D1SessionStore["validate"]>>;

      if (cached !== undefined) {
        // Positive cache hit — check expiresAt
        if (cached.expiresAt < Date.now()) {
          // Expired in cache — evict and fall through to D1
          invalidateSession(sessionHash);
          sessionResult = null;
        } else {
          // Valid cache hit — build result and proceed
          const { tokenResult, authKind } = buildSessionTokenResult(
            sessionHash,
            cached,
          );
          c.set("tokenResult", tokenResult);
          c.set("authKind", authKind);
          return next();
        }
      } else {
        sessionResult = null; // will be filled by D1 below
      }

      // Cache miss (or expired positive hit) — hit D1
      const sessionStore = new D1SessionStore(c.env.DB);
      sessionResult = await sessionStore.validate(sessionHash);

      if (!sessionResult) {
        // Record rate-limit failure and cache negative result
        if (ip) {
          const store = opts.rateLimitStore ?? new D1RateLimitStore(c.env.DB);
          try {
            await store.recordFailure(ip, RATE_LIMIT_WINDOW_MS);
          } catch {
            // Non-fatal
            try {
              c.env.ANALYTICS.writeDataPoint({
                blobs: ["auth", "rate_limit_d1_error", "record_failure"],
                doubles: [1],
                indexes: ["rate-limit"],
              });
            } catch {
              // Analytics emission is never load-bearing
            }
          }
        }
        setSessionInCache(sessionHash, false);
        return c.json(
          {
            ok: false,
            error: {
              code: "session-expired",
              message: "Session cookie is invalid or expired",
              retryable: false,
            },
          },
          401,
        );
      }

      // Valid D1 result — cache and proceed
      setSessionInCache(sessionHash, sessionResult);
      const { tokenResult: sessionTokenResult, authKind: sessionAuthKind } =
        buildSessionTokenResult(sessionHash, sessionResult);
      c.set("tokenResult", sessionTokenResult);
      c.set("authKind", sessionAuthKind);
      return next();
    }

    // 2. Token extraction
    const authHeader = c.req.header("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return c.json(
        {
          ok: false,
          error: {
            code: "unauthorized",
            message: "Missing or invalid Authorization header",
            retryable: false,
          },
        },
        401,
      );
    }

    const rawToken = authHeader.slice("Bearer ".length);

    // --- Session token path (tila_s. prefix) ---
    if (rawToken.startsWith("tila_s.")) {
      // Strip the "tila_s." prefix to get the underlying JWT
      const jwt = rawToken.slice("tila_s.".length);

      // JWT must have exactly 3 parts: header.payload.signature
      if (jwt.split(".").length !== 3) {
        return c.json(
          {
            ok: false,
            error: {
              code: "unauthorized",
              message: "Malformed session token",
              retryable: false,
            },
          },
          401,
        );
      }

      // Verify HMAC key is configured before attempting verification
      if (!c.env.GITHUB_SESSION_HMAC_KEY) {
        return c.json(
          {
            ok: false,
            error: {
              code: "hmac-not-configured",
              message: "Server configuration error: HMAC signing key not set",
              retryable: false,
            },
          },
          500,
        );
      }

      let payloadObj: unknown;
      try {
        // Use cached CryptoKey — avoids redundant importKey on every request
        const key = await getHmacKey(c.env.GITHUB_SESSION_HMAC_KEY);
        const { payload } = await jwtVerify(jwt, key);
        payloadObj = payload;
      } catch {
        return c.json(
          {
            ok: false,
            error: {
              code: "unauthorized",
              message: "Invalid session token signature",
              retryable: false,
            },
          },
          401,
        );
      }

      // Validate payload schema
      const parsed = SessionPayloadSchema.safeParse(payloadObj);
      if (!parsed.success) {
        return c.json(
          {
            ok: false,
            error: {
              code: "unauthorized",
              message: "Invalid session token payload",
              retryable: false,
            },
          },
          401,
        );
      }

      const payload = parsed.data;
      const rawPayload = payloadObj as { iss?: unknown; aud?: unknown };

      // Require iss to be present AND correct. mintSessionToken always sets
      // iss="tila"; accepting an absent iss would let an unsigned-claims token
      // (or a token minted for another purpose with the shared HMAC key) pass.
      if (rawPayload.iss !== "tila") {
        return c.json(
          {
            ok: false,
            error: {
              code: "unauthorized",
              message: "Invalid session token issuer",
              retryable: false,
            },
          },
          401,
        );
      }

      // Require aud to be present AND correct (mintSessionToken always sets
      // aud="tila"). The explicit undefined check is kept as a belt-and-suspenders
      // guard alongside isExpectedAudience, which now also fails closed on an
      // absent aud.
      if (
        rawPayload.aud === undefined ||
        !isExpectedAudience(rawPayload.aud, "tila")
      ) {
        return c.json(
          {
            ok: false,
            error: {
              code: "unauthorized",
              message: "Invalid session token audience",
              retryable: false,
            },
          },
          401,
        );
      }

      // Check expiry
      if (payload.expires_at <= Date.now() / 1000) {
        return c.json(
          {
            ok: false,
            error: {
              code: "session-expired",
              message: "Session token has expired",
              retryable: false,
            },
          },
          401,
        );
      }

      // --- C9: jti revocation check (fail-closed) ---
      // Only session tokens that carry a jti are subject to revocation checks.
      // Tokens minted before C9 land (no jti field) pass through unchanged.
      if (payload.jti) {
        const jti = payload.jti;

        // 1. Consult the per-isolate cache first (avoids D1 on every request)
        const cached = getJtiFromCache(jti);
        if (cached === true) {
          // Cached as revoked — deny immediately
          return c.json(
            {
              ok: false,
              error: {
                code: "session-revoked",
                message: "Session token has been revoked",
                retryable: false,
              },
            },
            401,
          );
        }

        if (cached === null) {
          // Cache miss or stale — query D1 (fail-closed on error)
          try {
            const revokedStore = new D1RevokedJtiStore(c.env.DB);
            const isRevoked = await revokedStore.isRevoked(jti);
            // Update cache for future requests (bounded by JTI_REV_CACHE_MAX_SIZE)
            setJtiInCache(jti, { revoked: isRevoked, cachedAt: Date.now() });
            if (isRevoked) {
              return c.json(
                {
                  ok: false,
                  error: {
                    code: "session-revoked",
                    message: "Session token has been revoked",
                    retryable: false,
                  },
                },
                401,
              );
            }
          } catch {
            // D1 lookup error — DENY (fail-closed per C9 design)
            return c.json(
              {
                ok: false,
                error: {
                  code: "unauthorized",
                  message: "Session token verification failed",
                  retryable: true,
                },
              },
              401,
            );
          }
        }
        // cached === false means "confirmed not revoked within TTL" — proceed
      }

      // Set session token result
      const sessionResult: SessionTokenResult = {
        kind: "session",
        projectId: payload.project_id,
        name: payload.github_login,
        scopes: payload.permission,
        tokenId: "",
        githubRepoId: payload.github_repo_id,
        githubLogin: payload.github_login,
        permission: payload.permission,
        expiresAt: payload.expires_at,
      };

      c.set("tokenResult", sessionResult);
      c.set("authKind", "bearer");
      return next();
    }

    // --- D1 token path (existing, unchanged) ---

    // 3. Hash
    const tokenHash = await hashToken(rawToken, c.env.HASH_PEPPER);

    // 4. Cache lookup
    const cached = getFromCache(tokenHash);
    if (cached === null) {
      // Negative cache hit -- invalid/revoked token
      if (ip) {
        const store = opts.rateLimitStore ?? new D1RateLimitStore(c.env.DB);
        try {
          await store.recordFailure(ip, RATE_LIMIT_WINDOW_MS);
        } catch {
          // Swallow — missed increment is acceptable
          try {
            c.env.ANALYTICS.writeDataPoint({
              blobs: ["auth", "rate_limit_d1_error", "record_failure"],
              doubles: [1],
              indexes: ["rate-limit"],
            });
          } catch {
            // Analytics emission is never load-bearing
          }
        }
      }
      return c.json(
        {
          ok: false,
          error: {
            code: "unauthorized",
            message: "Invalid or revoked token",
            retryable: false,
          },
        },
        401,
      );
    }

    let claims: TokenClaims | null;

    if (cached !== undefined) {
      // Positive cache hit
      claims = cached;
    } else {
      // 5. Cache miss -- D1 lookup
      const tokenStore = new D1TokenStore(c.env.DB);
      const result = await tokenStore.validate(tokenHash);
      if (!result) {
        setInCache(tokenHash, null); // negative cache
        if (ip) {
          const store = opts.rateLimitStore ?? new D1RateLimitStore(c.env.DB);
          try {
            await store.recordFailure(ip, RATE_LIMIT_WINDOW_MS);
          } catch {
            // Swallow — missed increment is acceptable
            try {
              c.env.ANALYTICS.writeDataPoint({
                blobs: ["auth", "rate_limit_d1_error", "record_failure"],
                doubles: [1],
                indexes: ["rate-limit"],
              });
            } catch {
              // Analytics emission is never load-bearing
            }
          }
        }
        return c.json(
          {
            ok: false,
            error: {
              code: "unauthorized",
              message: "Invalid or revoked token",
              retryable: false,
            },
          },
          401,
        );
      }
      claims = result;
      setInCache(tokenHash, claims); // positive cache
    }

    // 6. Debounced last_used_at write (fire-and-forget)
    const lastWrite = lastWriteMap.get(tokenHash) ?? 0;
    if (now - lastWrite > DEBOUNCE_MS) {
      if (lastWriteMap.has(tokenHash)) {
        lastWriteMap.delete(tokenHash);
      } else if (lastWriteMap.size >= MAX_DEBOUNCE_MAP_SIZE) {
        const oldest = lastWriteMap.keys().next().value;
        if (oldest !== undefined) {
          lastWriteMap.delete(oldest);
        }
      }
      lastWriteMap.set(tokenHash, now);
      const tokenStore = new D1TokenStore(c.env.DB);
      c.executionCtx.waitUntil(
        tokenStore.updateLastUsedAt(tokenHash).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(
            `[auth] updateLastUsedAt failed: token=${tokenHash.slice(0, 8)} err=${msg}`,
          );
          try {
            c.env.ANALYTICS.writeDataPoint({
              blobs: ["auth", "updateLastUsedAt_failure", msg],
              doubles: [1],
              indexes: [tokenHash.slice(0, 8)],
            });
          } catch {
            // Analytics emission is never load-bearing
          }
        }),
      );
    }

    // 7. Set context with d1-token discriminant
    c.set("tokenResult", { ...claims, kind: "d1-token" } as D1TokenResult);
    c.set("authKind", "bearer");
    return next();
  };
}

/** For testing only -- resets debounce state, isolate rate-limit map, and jti cache. */
export function _resetMiddlewareStateForTest(): void {
  lastWriteMap.clear();
  isolateFailMap.clear();
  jtiRevCache.clear();
  cachedHmacKey = null;
  cachedHmacKeyRaw = null;
  hashPepperUnsetWarned = false;
}

/** For testing only -- returns current debounce map size. */
export function _debounceMapSizeForTest(): number {
  return lastWriteMap.size;
}

/** For testing only -- returns current isolate fail-map size. */
export function _isolateFailMapSizeForTest(): number {
  return isolateFailMap.size;
}

/** For testing only -- returns current jti revocation cache size. */
export function _jtiRevCacheSizeForTest(): number {
  return jtiRevCache.size;
}

/** For testing only -- returns whether a jti key exists in the cache (regardless of TTL). */
export function _jtiRevCacheHasForTest(jti: string): boolean {
  return jtiRevCache.has(jti);
}
