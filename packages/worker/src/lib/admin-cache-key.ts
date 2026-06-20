export interface AdminCacheKeyParts {
  host: string;
  projectId: string;
  /** GitHub user ID — may be numeric; coerced to string in the key. */
  userId: string | number;
}

/**
 * Canonical per-isolate admin-grants cache key. Format is load-bearing:
 * the roster lookup and the revoke purge MUST produce byte-identical keys.
 *
 * Format: `${projectId}:${host}:${userId}`
 */
export function adminCacheKey({
  host,
  projectId,
  userId,
}: AdminCacheKeyParts): string {
  return `${projectId}:${host}:${userId}`;
}
