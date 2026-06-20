/**
 * Shared GitHub permission normalizer.
 *
 * GitHub returns a 6-tier permission level for repository collaborators:
 * none, read, triage, write, maintain, admin.
 *
 * This module normalizes those tiers into the 3-tier tila session permission
 * ("read" | "write" | "admin") and exports the underlying hierarchy table so
 * that other callers (permissionToScope, permissionMeetsMinimum) share a single
 * source of truth.
 *
 * Note: PERMISSION_LEVELS in permission.ts is a SEPARATE tila 3-tier gate
 * ranking and is NOT this table — do not conflate them.
 */

/** GitHub 6-tier permission hierarchy (ascending). */
export const PERMISSION_HIERARCHY: Record<string, number> = {
  none: 0,
  read: 1,
  triage: 2,
  write: 3,
  maintain: 4,
  admin: 5,
};

/**
 * Normalize a GitHub repository permission into a tila session permission tier.
 *
 * GitHub returns: none, read, triage, write, maintain, admin
 * Returns:        "read" | "write" | "admin"
 *
 * Unknown values fall back to "read" (least privilege, fail closed).
 */
export function normalizeGitHubPermission(
  githubPermission: string,
): "read" | "write" | "admin" {
  const level = PERMISSION_HIERARCHY[githubPermission] ?? 0;
  if (level >= PERMISSION_HIERARCHY.admin) return "admin";
  if (level >= PERMISSION_HIERARCHY.write) return "write";
  return "read";
}
