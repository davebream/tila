import { canonicalizePrincipal } from "./principal";

/**
 * D1-backed store for subject-level bulk-revocation tombstones (WI-C, epic #122).
 *
 * Security contract:
 * - This store is PROJECT-SCOPED: every lookup and write is scoped to
 *   (project_id, identity_host, subject_id). A revocation in project A never
 *   affects project B, even for the same principal.
 *
 * DON'T harmonize this store with D1RevokedJtiStore: jti revocation is
 * deliberately GLOBAL (no project filter). Subject revocation is intentionally
 * per-project. Merging them would either make jti revocation fail-open or
 * subject revocation leak across project boundaries.
 *
 * - `getRevokedBefore` does NOT catch D1 errors. Callers (auth.ts) are
 *   responsible for fail-closed handling (deny-on-throw).
 * - `revokeSubject` uses an upsert with MAX semantics so that `revoked_before`
 *   can only move forward — a later call with an earlier cutoff is a no-op.
 */
export class D1RevokedSubjectsStore {
  constructor(private db: D1Database) {}

  /**
   * Return the `revoked_before` EpochMillis cutoff for a (project, host, subject)
   * principal, or `null` if no tombstone exists.
   *
   * Does NOT catch errors — callers must treat a thrown error as revoked
   * (fail-closed). See auth.ts gate implementation for the try/catch.
   *
   * Canonicalizes host and subject via canonicalizePrincipal() so a lookup with
   * "GitHub.COM" finds the same row as one written with "github.com".
   */
  async getRevokedBefore(
    projectId: string,
    host: string,
    subject: string | number,
  ): Promise<number | null> {
    const { identityHost, subjectId } = canonicalizePrincipal(host, subject);

    const row = await this.db
      .prepare(
        "SELECT revoked_before FROM _revoked_subjects WHERE project_id = ? AND identity_host = ? AND subject_id = ? LIMIT 1",
      )
      .bind(projectId, identityHost, subjectId)
      .first<{ revoked_before: number }>();

    return row?.revoked_before ?? null;
  }

  /**
   * Arm a subject-level kill-switch for a (project, host, subject) principal.
   *
   * `revokedBefore` is a `nowMs()`-at-arm timestamp: any session whose
   * `issued_at` (in ms) is strictly less than `revokedBefore` will be denied.
   * Pass `nowMs()` to revoke all currently-active sessions; pass a future value
   * for a forward-looking ban that covers sessions not yet issued.
   *
   * Monotonic MAX: if a tombstone already exists with a larger `revoked_before`,
   * this call is a no-op (the cutoff can only move forward, never backward).
   *
   * Canonicalizes host and subject via canonicalizePrincipal() before writing.
   */
  async revokeSubject(
    projectId: string,
    host: string,
    subject: string | number,
    revokedBefore: number,
  ): Promise<void> {
    const { identityHost, subjectId } = canonicalizePrincipal(host, subject);

    await this.db
      .prepare(
        "INSERT INTO _revoked_subjects (project_id, identity_host, subject_id, revoked_before) VALUES (?, ?, ?, ?) ON CONFLICT (project_id, identity_host, subject_id) DO UPDATE SET revoked_before = MAX(revoked_before, excluded.revoked_before)",
      )
      .bind(projectId, identityHost, subjectId, revokedBefore)
      .run();
  }
}
