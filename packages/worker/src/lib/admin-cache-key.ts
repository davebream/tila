export interface AdminCacheKeyParts {
  host: string;
  projectId: string;
  userId: string;
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
