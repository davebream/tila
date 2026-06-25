import { canonicalizePrincipal } from "./principal";

/**
 * Atomic principal-offboard batch (WI-D, epic #122).
 *
 * Fans out, in a single `db.batch()` (one implicit D1 transaction —
 * all-or-nothing), the three write classes that take a GitHub principal out of
 * a project:
 *   1. soft-delete the principal's active `_admin_grants` rows;
 *   2. arm a `_revoked_subjects` tombstone (upsert-MAX) — this single O(1) write
 *      kills ALL of that principal's live sessions at verify time, so no
 *      per-session `_session_index` enumeration is needed;
 *   3. revoke 0..N named `_tokens` (D1 API tokens) the admin chooses to kill.
 *
 * Canonicalization parity: host/subject are routed through the shared
 * `canonicalizePrincipal()` so the tombstone and grant rows match the verifier
 * (auth.ts) byte-for-byte. A degenerate (empty) subject throws BEFORE any batch
 * is issued.
 *
 * Time units (do not mix — see migration 0019 + lib/time.ts):
 *   - `_revoked_subjects.revoked_before` is EpochMillis  → pass `nowMsValue`.
 *   - `_admin_grants.revoked_at` / `_tokens.revoked_at`  are EpochSeconds → `nowSecValue`.
 *
 * Raw `db.prepare()` statements (not Drizzle) are used because `db.batch()`
 * requires `D1PreparedStatement`s and the `_revoked_subjects` ON CONFLICT ... MAX
 * upsert is the documented WI-C exception to the Drizzle rule. The SQL mirrors
 * the canonical forms in `revoked-subjects-store.ts` / `admin-grants.ts`.
 */
export interface RevokePrincipalParams {
  projectId: string;
  /** Raw identity host; canonicalized internally. Defaults handled by caller. */
  host: string;
  /** Raw GitHub subject (user id); canonicalized internally. */
  subject: string | number;
  /** Numeric acting-admin id for the `_admin_grants` audit column (null for D1-token actors). */
  revokedByUserId: number | null;
  /** Free-string actor for `_tokens.revoked_by` (e.g. `gh:123` or `d1-token`). */
  revokedBySnapshot: string;
  /** D1 token names to revoke in the same batch (0..N). */
  tokenNames?: string[];
  /** Current time as EpochMillis (injected for deterministic tests). */
  nowMsValue: number;
  /** Current time as EpochSeconds (injected for deterministic tests). */
  nowSecValue: number;
}

export interface RevokePrincipalResult {
  /** True when an active admin grant existed and was soft-deleted. */
  grantsRevoked: boolean;
  /** The EpochMillis cutoff written to the `_revoked_subjects` tombstone. */
  revokedBefore: number;
  /** token_hash of each token actually revoked (for cache purge + session cascade). */
  tokenHashes: string[];
}

export async function revokePrincipalBatch(
  db: D1Database,
  params: RevokePrincipalParams,
): Promise<RevokePrincipalResult> {
  // Canonicalize ONCE, before any SQL. Throws on empty subject (caller → 400).
  const { identityHost, subjectId } = canonicalizePrincipal(
    params.host,
    params.subject,
  );

  const tokenNames = params.tokenNames ?? [];

  // Statement 0: soft-delete active admin grants for this principal.
  const grantStmt = db
    .prepare(
      "UPDATE _admin_grants SET revoked_at = ?, revoked_by_user_id = ? WHERE project_id = ? AND identity_host = ? AND subject_id = ? AND revoked_at IS NULL",
    )
    .bind(
      params.nowSecValue,
      params.revokedByUserId,
      params.projectId,
      identityHost,
      subjectId,
    );

  // Statement 1: arm the subject-revocation tombstone (upsert-MAX, ms cutoff).
  const tombstoneStmt = db
    .prepare(
      "INSERT INTO _revoked_subjects (project_id, identity_host, subject_id, revoked_before) VALUES (?, ?, ?, ?) ON CONFLICT (project_id, identity_host, subject_id) DO UPDATE SET revoked_before = MAX(revoked_before, excluded.revoked_before)",
    )
    .bind(params.projectId, identityHost, subjectId, params.nowMsValue);

  // Statements 2..N: revoke named D1 tokens, RETURNING token_hash for cache purge.
  const tokenStmts = tokenNames.map((name) =>
    db
      .prepare(
        "UPDATE _tokens SET revoked_at = ?, revoked_by = ? WHERE project_id = ? AND name = ? AND revoked_at IS NULL RETURNING token_hash",
      )
      .bind(
        params.nowSecValue,
        params.revokedBySnapshot,
        params.projectId,
        name,
      ),
  );

  const statements = [grantStmt, tombstoneStmt, ...tokenStmts];

  // Single implicit transaction: all statements commit together or none do.
  const results = await db.batch<{ token_hash: string }>(statements);

  // results[0] = grant soft-delete. The `revoked_at IS NULL` guard means a
  // matched row always changes, so meta.changes>0 ⇔ an active grant existed.
  const grantsRevoked = (results[0]?.meta?.changes ?? 0) > 0;

  // results[2..] = token revokes; RETURNING rows live in `.results`, not `.meta`.
  const tokenHashes: string[] = [];
  for (let i = 2; i < results.length; i++) {
    const rows = results[i]?.results ?? [];
    for (const row of rows) {
      if (row?.token_hash) tokenHashes.push(row.token_hash);
    }
  }

  return {
    grantsRevoked,
    revokedBefore: params.nowMsValue,
    tokenHashes,
  };
}
