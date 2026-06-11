/**
 * Best-effort detection of a PRE-FEATURE local DB that cannot fully upgrade.
 *
 * Local DBs created by the OLD / pre-feature CLI used the legacy
 * `ALL_LOCAL_MIGRATIONS` with a *divergent* v1 and v5. Because v1 and v5 are
 * already recorded in such a file's `_migrations`, the embedded runner treats
 * them as applied and SKIPS them — so the canonical `artifact_relationships.target`
 * column and the canonical v5 `idx_er_to_id_type` index stay absent (see
 * docs/02-ARCHITECTURE.md §1.6a, "Pre-feature local DB upgrade"). This is SILENT
 * otherwise; an in-place auto-heal is intentionally NOT attempted (it cannot
 * reproduce the canonical NOT-NULL primary-key `target` column).
 *
 * This module surfaces the situation as a one-time, best-effort open-time
 * WARNING. It is:
 *  - runtime-agnostic (no `node:*` / `bun:*` imports): it inspects the
 *    already-built `MigrationStorage` the host already constructed, so both the
 *    Bun and Node connection paths reuse the exact same detection logic;
 *  - never-throwing: any inspection failure is swallowed (a warning must never
 *    break opening a DB).
 */

import type { MigrationStorage } from "./migrations";

/**
 * Return `true` iff `storage` points at a pre-feature DB that did not fully
 * upgrade: `_migrations` records canonical v1 AND v5, yet
 * `artifact_relationships` lacks the canonical `target` column. Best-effort —
 * returns `false` on any inspection error (treat "can't tell" as "fine").
 */
export function isStalePreFeatureSchema(storage: MigrationStorage): boolean {
  try {
    // Canonical markers v1 + v5 recorded?
    const versions = new Set(
      (
        storage.sql.exec("SELECT version FROM _migrations").toArray() as {
          version: number;
        }[]
      ).map((r) => r.version),
    );
    if (!versions.has(1) || !versions.has(5)) return false;

    // ...but artifact_relationships missing the `target` column?
    const cols = storage.sql
      .exec("PRAGMA table_info(artifact_relationships)")
      .toArray() as { name: string }[];
    // If the table itself is absent (no rows), this is not the pre-feature
    // shape we warn about — only warn when the table EXISTS but lacks `target`.
    if (cols.length === 0) return false;
    const hasTarget = cols.some((c) => c.name === "target");
    return !hasTarget;
  } catch {
    return false;
  }
}

/**
 * The actionable warning message for a detected pre-feature DB. Exported so the
 * host wrappers (and tests) share one string.
 */
export const PRE_FEATURE_SCHEMA_WARNING =
  "tila: this local database was created by an older tila version and cannot be " +
  "fully upgraded in place (the canonical artifact_relationships.target column / v5 " +
  "index are absent). Recreate it with `tila init --local` to get the current schema.";

/**
 * Inspect `storage` and, if it is a stale pre-feature DB, emit a single
 * best-effort `console.warn`. Never throws.
 */
export function warnIfStalePreFeatureSchema(storage: MigrationStorage): void {
  try {
    if (isStalePreFeatureSchema(storage)) {
      console.warn(PRE_FEATURE_SCHEMA_WARNING);
    }
  } catch {
    // best-effort: a warning must never break opening a DB
  }
}
