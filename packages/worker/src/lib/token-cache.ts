import { LruTtlCache } from "./lru-ttl-cache";

export interface TokenClaims {
  projectId: string;
  name: string;
  scopes: string;
  tokenId: string;
  kind?: "d1-token"; // Added for backward compat; existing entries lack it
}

const cache = new LruTtlCache<TokenClaims | null>({
  maxSize: 1000,
  positiveTtlMs: 60_000, // 60s -- positive cache
  negativeTtlMs: 10_000, // 10s -- negative cache (unknown/revoked)
});

/**
 * Look up a token hash in the cache.
 * @returns TokenClaims on positive hit, null on negative hit, undefined on miss/expired.
 */
export function getFromCache(
  tokenHash: string,
): TokenClaims | null | undefined {
  if (!tokenHash) return undefined; // guard against empty string lookups
  return cache.get(tokenHash);
}

/**
 * Store a validation result in the cache with appropriate TTL.
 * Pass null for result to create a negative cache entry.
 */
export function setInCache(
  tokenHash: string,
  result: TokenClaims | null,
): void {
  cache.set(tokenHash, result, result === null);
}

/**
 * Remove a token hash from the cache. Called on revocation (by T3).
 */
export function invalidate(tokenHash: string): void {
  cache.delete(tokenHash);
}

/** For testing only -- resets all module-level state. */
export function _clearCacheForTest(): void {
  cache.clear();
}

/** For testing only -- returns current cache size. */
export function _cacheSizeForTest(): number {
  return cache.size;
}
