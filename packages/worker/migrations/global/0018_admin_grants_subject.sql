-- Migration 0013: _admin_grants subject-level principal identity (epic #122 / WI-C).
--
-- Adds canonical (identity_host, subject_id) TEXT columns alongside the legacy
-- github_host / github_user_id columns (retained; NOT NULL — backward compatible).
-- Backfill applies the SAME canonicalization as canonicalizePrincipal():
--   identity_host = lower(trim(github_host))
--   subject_id    = trim(cast(github_user_id as text))
-- A raw '= github_host' backfill would store 'GitHub.com' verbatim while
-- check-time canonicalizes to 'github.com' → silent fail-open mismatch (critic F2).
--
-- Index ordering: the new partial unique index is created BEFORE the old one is
-- dropped so active-grant uniqueness is enforced throughout the migration.
--
-- subject_id is NOT NULL DEFAULT '': NOT nullable, so the partial unique index
-- cannot be defeated by SQLite's NULL-distinct rule (every NULL is DISTINCT in a
-- UNIQUE index, which would let two active grants with NULL subject_id coexist).
-- The '' default is overwritten by the backfill for every existing row.

ALTER TABLE _admin_grants ADD COLUMN identity_host TEXT NOT NULL DEFAULT 'github.com';
ALTER TABLE _admin_grants ADD COLUMN subject_id    TEXT NOT NULL DEFAULT '';

-- Backfill existing rows to match canonicalizePrincipal() output exactly.
UPDATE _admin_grants
   SET identity_host = lower(trim(github_host)),
       subject_id    = trim(CAST(github_user_id AS TEXT));

-- Create the new partial unique index first (uniqueness never unprotected).
CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_grants_active_subject
  ON _admin_grants (project_id, identity_host, subject_id)
  WHERE revoked_at IS NULL;

-- Drop the old index only after the new one is in place.
DROP INDEX IF EXISTS idx_admin_grants_active;
