/**
 * admin-user-arg.ts
 *
 * Pure helpers for resolving the <user> positional argument in `tila admin
 * grant|revoke` into the body shape the roster API expects.
 *
 * All-digits  → { github_user_id: number }
 * Login string → { login: string }
 * Revoke with login → best-effort lookup against an admin-list snapshot
 *   (TOCTOU note: the snapshot is fetched immediately before use, but there
 *   is a window between list and delete. The server's idempotent soft-delete
 *   is the safety net if the id disappears between the two calls.)
 */

export type GrantBody = { github_user_id: number } | { login: string };

export interface AdminListRow {
  github_user_id: number;
  login: string | null;
  granted_by: number | null;
  granted_at: number;
}

/**
 * Parse a <user> argument into the POST /admins body.
 * All-digits → { github_user_id }
 * Otherwise  → { login }
 */
export function parseGrantArg(user: string): GrantBody {
  if (/^\d+$/.test(user)) {
    return { github_user_id: Number(user) };
  }
  return { login: user };
}

/**
 * Resolve a revoke <user> argument to a numeric github_user_id.
 *
 * - All-digits → use directly.
 * - Login → look up in the provided snapshot list. The snapshot must be
 *   non-null for login resolution to succeed.
 *   - When found and the row's login is set, return its id.
 *   - When the row's login_snapshot is null, or no matching row exists, return
 *     a "needs numeric id" error. This covers the common case where the admin
 *     was originally granted by numeric id (snapshot = null).
 *
 * @param user  The raw <user> argument.
 * @param snapshot  The current roster returned by GET /admins, or null if the
 *   list call failed. Null triggers an error requiring a numeric id.
 * @returns The numeric github_user_id, or an error string.
 */
export function resolveRevokeArg(
  user: string,
  snapshot: AdminListRow[] | null,
): { id: number } | { error: string } {
  // Numeric id — use directly
  if (/^\d+$/.test(user)) {
    return { id: Number(user) };
  }

  // Login resolution requires a snapshot
  if (snapshot === null) {
    return {
      error: `Cannot resolve login "${user}" to a github_user_id (admin list unavailable). Pass the numeric id instead (run \`tila admin list\` to find it).`,
    };
  }

  // Find row where login snapshot matches
  const row = snapshot.find(
    (r) => r.login !== null && r.login.toLowerCase() === user.toLowerCase(),
  );

  if (!row) {
    return {
      error: `Login "${user}" not found in the current admin roster. Pass the numeric github_user_id (run \`tila admin list\` to find it).`,
    };
  }

  if (row.login === null) {
    // Should not reach here given the find() check, but guard defensively
    return {
      error:
        "Login snapshot is null for that admin row. Pass the numeric github_user_id instead (run `tila admin list` to find it).",
    };
  }

  return { id: row.github_user_id };
}
