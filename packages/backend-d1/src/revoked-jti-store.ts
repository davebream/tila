import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { revokedJti } from "./schema";

/**
 * D1-backed store for revoked session JWT identifiers (jti).
 *
 * Security contract (C9):
 * - `isRevoked` returns true if the jti is in the revocation set.
 * - If the D1 lookup throws, callers MUST treat it as revoked (fail-closed).
 *   The fail-closed policy is enforced in auth.ts, not here.
 * - `revoke` inserts a jti tombstone; idempotent via ON CONFLICT DO NOTHING.
 *
 * Revocation is a GLOBAL session kill-switch (see docs/01-DECISIONS.md §C9):
 *
 * - DO: keep `isRevoked(jti)` a single-column PRIMARY-KEY lookup on `jti`.
 *   It MUST stay unconditional — NEVER compound, NEVER filtered by
 *   `project_id` (or any other column). A jti is either globally revoked or
 *   it is not; there is no per-project revocation scope.
 * - DON'T: add a `project_id` (or other) filter to `isRevoked`. A scoped
 *   lookup would let a revoked jti slip through whenever the caller's project
 *   differs from the recorded one — a silent FAIL-OPEN of the kill-switch.
 *   This is the single highest-severity footgun in this file.
 * - The `project_id` stored by `revoke()` is PROVENANCE/AUDIT, not scope. It
 *   is trustworthy only when the caller supplied a *verifiable* token: a
 *   bare-jti revoke (no token to verify) records ASSERTED (unverified)
 *   provenance — the caller's claimed slug. There is no jti→project
 *   derivation; the column never gates whether the jti counts as revoked.
 */
export class D1RevokedJtiStore {
  private db;

  constructor(d1: D1Database) {
    this.db = drizzle(d1);
  }

  /**
   * Check whether a jti has been revoked.
   * Returns `true` if revoked, `false` if not found.
   * Does NOT catch errors — callers are responsible for fail-closed handling.
   *
   * DON'T add a `project_id` (or any other) filter to this WHERE clause — it
   * must remain a single-column PK lookup on `jti`. A project filter would
   * make revocation fail-open (a revoked jti would pass for a different
   * project). See the class contract above and docs/01-DECISIONS.md §C9.
   */
  async isRevoked(jti: string): Promise<boolean> {
    const rows = await this.db
      .select({ jti: revokedJti.jti })
      .from(revokedJti)
      .where(eq(revokedJti.jti, jti))
      .limit(1);

    return rows.length > 0;
  }

  /**
   * Mark a jti as revoked. Idempotent: a duplicate insert is silently ignored.
   */
  async revoke(jti: string, projectId: string): Promise<void> {
    await this.db
      .insert(revokedJti)
      .values({
        jti,
        project_id: projectId,
        revoked_at: Date.now(), // ms (EpochMillis) — Worker brands at read via asEpochMillis
      })
      .onConflictDoNothing();
  }
}
