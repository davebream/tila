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
        revoked_at: Date.now(),
      })
      .onConflictDoNothing();
  }
}
