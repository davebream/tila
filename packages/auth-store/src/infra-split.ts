/**
 * splitInfraConfig — loss-free composite TilaInfraConfig → InfraRecord
 *
 * Maps every non-secret field to `meta` (PerSlugInfraMeta) and the three
 * secret fields (hmac_key / sweep_secret / infra_admin_token) to `secrets`
 * (or null when none are present). Throws on any unmapped non-secret field
 * to guard against future schema drift.
 *
 * WI-M / C5 / F-C fix: r2_bucket_name is added to PerSlugInfraMeta so the
 * split is loss-free.
 */

import type {
  InfraSecrets,
  PerSlugInfraMeta,
  TilaInfraConfig,
} from "@tila/schemas";
import type { InfraRecord } from "./auth-store.js";

// Explicit allowlist of non-secret TilaInfraConfig keys that map to meta.
// Any key absent from this list AND the SECRETS_KEYS list causes a throw.
const META_KEYS: ReadonlySet<string> = new Set([
  "account_id",
  "account_name",
  "d1_database_id",
  "worker_url",
  "r2_bucket_name",
  "github_app",
  "pages_project_name",
  "infra_slug",
]);

// Secret keys that map to the keychain — never written to disk.
const SECRET_KEYS: ReadonlySet<string> = new Set([
  "hmac_key",
  "sweep_secret",
  "infra_admin_token",
]);

/**
 * Split a flat composite TilaInfraConfig into an InfraRecord
 * (non-secret meta + secret part).
 *
 * Throws Error("unmapped infra field: <key>") if the config contains a key
 * that is neither in the meta allowlist nor in the secret key set. This
 * catches future TilaInfraConfig additions that the caller forgot to place.
 */
export function splitInfraConfig(config: TilaInfraConfig): InfraRecord {
  const meta: Partial<PerSlugInfraMeta> = {};
  const secretParts: Partial<InfraSecrets> = {};
  let hasSecret = false;

  for (const [rawKey, value] of Object.entries(config)) {
    if (value === undefined) continue; // skip undefined optionals

    if (META_KEYS.has(rawKey)) {
      (meta as Record<string, unknown>)[rawKey] = value;
    } else if (SECRET_KEYS.has(rawKey)) {
      (secretParts as Record<string, unknown>)[rawKey] = value;
      hasSecret = true;
    } else {
      throw new Error(`unmapped infra field: ${rawKey}`);
    }
  }

  return {
    meta: meta as PerSlugInfraMeta,
    secrets: hasSecret ? (secretParts as InfraSecrets) : null,
  };
}
