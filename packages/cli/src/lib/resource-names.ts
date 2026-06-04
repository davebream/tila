/**
 * Fixed account-global Cloudflare resource names for tila.
 *
 * These are NOT slug-derived — they are shared across all tila projects in the
 * same Cloudflare account. The D1 `DB` binding and R2 `ARTIFACTS` binding in
 * `worker/wrangler.toml` mirror these values; TOML cannot import TypeScript so
 * the duplication there is intentional and accepted.
 *
 * Update both this file AND `worker/wrangler.toml` if the names ever change.
 */

/** Name of the global tila D1 database. */
export const D1_DATABASE_NAME = "tila-global";

/** Name of the global tila R2 artifacts bucket. */
export const R2_BUCKET_NAME = "tila-artifacts";
