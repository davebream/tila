-- Migration 0014: _revoked_subjects bulk-revocation tombstones (epic #122 / WI-C).
--
-- One row per principal per project. The unique index backs the upsert-MAX in
-- D1RevokedSubjectsStore.revokeSubject (ON CONFLICT DO UPDATE SET
-- revoked_before = MAX(revoked_before, excluded.revoked_before)), so a kill-switch
-- cutoff can only move forward — re-arming never un-revokes already-covered sessions.
--
-- MANUAL INSERTS MUST be pre-canonicalized to match canonicalizePrincipal():
--   identity_host = lower(trim(host)),  subject_id = trim(cast(subject as text)).
-- A non-canonical row (e.g. 'GitHub.com') will silently never match at verify time
-- because auth.ts derives the principal via canonicalizePrincipal().
--
-- revoked_before is Unix ms (EpochMillis); cf. _revoked_jti.revoked_at.
-- NEVER store EpochSeconds here — see time.ts for the canonical ms unit.

CREATE TABLE IF NOT EXISTS _revoked_subjects (
  project_id     TEXT    NOT NULL,
  identity_host  TEXT    NOT NULL DEFAULT 'github.com',
  subject_id     TEXT    NOT NULL,
  revoked_before INTEGER NOT NULL  -- Unix ms (EpochMillis); cf. _revoked_jti.revoked_at; never seconds
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_revoked_subjects_principal
  ON _revoked_subjects (project_id, identity_host, subject_id);
