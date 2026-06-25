import { D1DeploymentMetaStore } from "@tila/backend-d1";

/**
 * Per-isolate cache for the deployment instance id.
 *
 * The id is immutable once written, so there is no TTL — it is cached for the
 * entire lifetime of the Worker isolate, mirroring the `cachedHmacKey` pattern
 * in `middleware/auth.ts`. Only the resolved string is cached; a throw from
 * `ensure()` is never cached so the next request can retry (relevant during a
 * transient D1 outage on a cold isolate).
 */
let cachedInstanceId: string | null = null;

/**
 * Returns the stable deployment instance id, using a module-level per-isolate
 * cache. On a cache miss it calls `D1DeploymentMetaStore.ensure()` which reads
 * the `_deployment_meta` singleton row and backfills idempotently if absent.
 *
 * Throws `DeploymentIdUnavailable` (from the store) if the id cannot be
 * resolved — callers must handle this explicitly (mint: propagate 5xx;
 * validate: reject present-claim, accept absent-claim).
 */
export async function ensureDeploymentInstanceId(
  db: D1Database,
): Promise<string> {
  if (cachedInstanceId !== null) return cachedInstanceId;

  const store = new D1DeploymentMetaStore(db);
  // Do NOT cache the throw — let the next call retry.
  const id = await store.ensure();
  cachedInstanceId = id;
  return id;
}

/**
 * Reset the module-level cache. For testing only — mirrors `_clearCacheForTest`
 * in other worker cache modules.
 */
export function __resetInstanceCache(): void {
  cachedInstanceId = null;
}
