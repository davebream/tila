/**
 * promoteLegacy — migrate legacy .tila credential + infra into the AuthStore (WI-M / C3)
 *
 * Copy-and-leave semantics: legacy files are NEVER deleted or modified.
 * Guards run in order: CI → non-TTY → dedup → already-present → no-data → dry-run → write.
 *
 * Write ordering is forced by AuthStore.#assertTrusted:
 *   registerInstance → markTrusted → putCredential → putInfra → setCurrentContext
 */

import type { InstanceKey } from "@tila/schemas";
import type { AuthStore } from "./auth-store.js";
import { splitInfraConfig } from "./infra-split.js";
import type { LegacyLocations } from "./legacy-reader.js";
import { readLegacyCredential, readLegacyInfraBlobs } from "./legacy-reader.js";
import type { EnvProbe } from "./secret-store.js";
import { canonicalizeWorkerUrl } from "./worker-url.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface PromoteOptions {
  authStore: AuthStore;
  legacy: LegacyLocations;
  env: EnvProbe;
  workerUrl: string;
  label?: string;
  dryRun?: boolean;
}

export interface PromoteResult {
  promotedCredential: boolean;
  promotedInfraSlugs: string[];
  instanceKey: InstanceKey | null;
  skippedReason?: "ci" | "non-tty" | "already-present" | "no-legacy-data";
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Promote legacy .tila credentials and infra into the three-tier AuthStore.
 *
 * See module docstring for the full write-ordering contract and guard order.
 */
export async function promoteLegacy(
  opts: PromoteOptions,
): Promise<PromoteResult> {
  const { authStore, legacy, env, workerUrl, label, dryRun } = opts;

  const EMPTY: PromoteResult = {
    promotedCredential: false,
    promotedInfraSlugs: [],
    instanceKey: null,
  };

  // Guard 1: CI
  if (env.isCI) {
    return { ...EMPTY, skippedReason: "ci" };
  }

  // Guard 2: non-TTY
  if (!env.isTTY) {
    return { ...EMPTY, skippedReason: "non-tty" };
  }

  // Dedup by worker_url (F-E): find an existing instance for this workerUrl.
  const canonUrl = canonicalizeWorkerUrl(workerUrl);
  const existingInstances = await authStore.listInstances();
  const matchedInstance = existingInstances.find(
    (r) => canonicalizeWorkerUrl(r.worker_url) === canonUrl,
  );

  let instanceKey: InstanceKey;
  let instanceExists = false;

  if (matchedInstance) {
    instanceKey = matchedInstance.instance_key;
    instanceExists = true;

    // already-present guard (F-A): instance is trusted AND has a readable credential
    if (matchedInstance.trust.trusted) {
      const existingCred = await authStore.getCredential(instanceKey);
      if (existingCred !== null) {
        return {
          promotedCredential: false,
          promotedInfraSlugs: [],
          instanceKey,
          skippedReason: "already-present",
        };
      }
      // Partial-promotion crash state: trusted but no credential → fall through to write
    }
  } else {
    // Mint a fresh client-uuid key
    instanceKey = crypto.randomUUID() as InstanceKey;
  }

  // Read legacy data
  const legacyCred = readLegacyCredential(legacy);
  const legacyInfraBlobs = readLegacyInfraBlobs(legacy);

  // Guard: no-legacy-data (only when no existing instance to recover)
  if (!instanceExists && legacyCred === null && legacyInfraBlobs.length === 0) {
    return { ...EMPTY, skippedReason: "no-legacy-data" };
  }

  // Compute what would be promoted (for dryRun reporting)
  const willPromoteCredential = legacyCred !== null;
  const willPromoteInfraSlugs = legacyInfraBlobs.map((b) => b.slug);

  // dryRun: report intent without writing
  if (dryRun) {
    return {
      promotedCredential: willPromoteCredential,
      promotedInfraSlugs: willPromoteInfraSlugs,
      instanceKey,
    };
  }

  // Step a: register (idempotent for same key+identity)
  await authStore.registerInstance({
    instance_key: instanceKey,
    instance_id_source: "client-uuid",
    worker_url: workerUrl,
    label,
  });

  // Step b: mark trusted
  await authStore.markTrusted(instanceKey);

  // Step c: write credential if present
  let promotedCredential = false;
  if (legacyCred !== null) {
    await authStore.putCredential(instanceKey, {
      instance_key: instanceKey,
      token: legacyCred.token,
      token_type: "Bearer",
      expires_at: legacyCred.expires_at, // already ms (or null for .env)
      obtained_at: Date.now(),
    });
    promotedCredential = true;
  }

  // Step d: write infra blobs
  const promotedInfraSlugs: string[] = [];
  for (const blob of legacyInfraBlobs) {
    const infraRecord = splitInfraConfig(blob.config);
    await authStore.putInfra(blob.slug, infraRecord);
    promotedInfraSlugs.push(blob.slug);
  }

  // Step e: set current context only when none is set
  const currentCtx = await authStore.getCurrentContext();
  if (currentCtx === null) {
    await authStore.setCurrentContext(instanceKey);
  }

  return {
    promotedCredential,
    promotedInfraSlugs,
    instanceKey,
  };
}
