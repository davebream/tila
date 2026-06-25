/**
 * infra-fallback.ts — per-slug store preferred read with flat-file fallback.
 *
 * Prefer the per-slug AuthStore record (`authStore.getInfra(slug)`) when
 * present; fall back to the flat `~/.tila/infra.toml` otherwise.
 * This is WI-M's additive read path — flat files keep working unchanged.
 * Full per-slug-only cutover (no flat file required) is WI-N scope.
 */
import type { AuthStore } from "@tila/auth-store";
import type { TilaInfraConfig } from "@tila/schemas";
import { getInfraSlug, loadInfraConfig } from "./infra-config.js";

/**
 * Resolve the current infra config, preferring the per-slug AuthStore record
 * when present and falling back to the flat infra.toml otherwise.
 *
 * Read order:
 *   1. Load flat infra.toml (always — determines the slug; throws if absent).
 *   2. Look up `authStore.getInfra(slug)`.
 *   3. If the per-slug record exists, merge meta + secrets into TilaInfraConfig.
 *   4. Otherwise return the flat config unchanged.
 */
export async function resolveInfraConfig(
  tilaDir: string,
  authStore: AuthStore,
): Promise<TilaInfraConfig> {
  // Step 1: load flat file — throws with the original error when absent
  const flatConfig = loadInfraConfig(tilaDir);

  // Step 2: determine slug and query the per-slug store
  const slug = getInfraSlug(flatConfig);
  const record = await authStore.getInfra(slug);

  // Step 3: per-slug record wins when present
  if (record !== null) {
    return {
      ...record.meta,
      ...(record.secrets ?? {}),
    };
  }

  // Step 4: no per-slug entry — use flat config as-is
  return flatConfig;
}
