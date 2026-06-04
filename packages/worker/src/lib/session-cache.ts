import type { SessionResult } from "@tila/backend-d1";
import { LruTtlCache } from "./lru-ttl-cache";

const cache = new LruTtlCache<SessionResult | false>({
  maxSize: 500,
  positiveTtlMs: 60_000, // 60s -- positive cache (valid session)
  negativeTtlMs: 10_000, // 10s -- negative cache (invalid/expired session)
});

/**
 * Look up a session hash in the cache.
 * @returns SessionResult on positive hit, false on negative hit (invalid session),
 *          undefined on miss or expired entry.
 */
export function getSessionFromCache(
  sessionHash: string,
): SessionResult | false | undefined {
  if (!sessionHash) return undefined;
  return cache.get(sessionHash);
}

/**
 * Store a session validation result in the cache with appropriate TTL.
 * Pass false to create a negative cache entry (invalid session).
 */
export function setSessionInCache(
  sessionHash: string,
  result: SessionResult | false,
): void {
  cache.set(sessionHash, result, result === false);
}

/**
 * Remove a session hash from the cache.
 * Called on session revocation or token revocation cascade.
 */
export function invalidateSession(sessionHash: string): void {
  cache.delete(sessionHash);
}

/** For testing only -- resets all module-level state. */
export function _clearSessionCacheForTest(): void {
  cache.clear();
}

/** For testing only -- returns current cache size. */
export function _sessionCacheSizeForTest(): number {
  return cache.size;
}
