/**
 * AuthStore — the single client-side persistence facade for @tila/auth-store.
 *
 * Composes:
 *   - Registry tier (tier 1): ~/.tila/instances.toml via registry-file.ts
 *   - Credential tier (tier 2): OS keychain tila:credential/<instance_key>
 *   - Refresh tier (tier 3): OS keychain tila:refresh/<instance_key>
 *   - Infra tier (tier 4): ~/.tila/infra/<slug>.toml + keychain tila:infra/<slug>
 *
 * The SecretStore seam is injected — use KeyringSecretStore for production or
 * FakeSecretStore / ThrowingSecretStore in tests.
 *
 * ## Write ordering (cross-tier consistency)
 * On a login that registers + stores credentials, the SECRET is written to the
 * keychain BEFORE the registry pointer (disk). A crash between them leaves an
 * unreachable (harmless) keychain entry rather than a dangling registry pointer
 * to a missing credential. This ordering is intentional and must not be reversed.
 */

import { existsSync, readdirSync } from "node:fs";
import {
  type CredentialRecord,
  CredentialRecordSchema,
  type InfraSecrets,
  InfraSecretsSchema,
  type InstanceKey,
  InstanceKey as InstanceKeySchema,
  type InstanceRecord,
  type PerSlugInfraMeta,
  type RefreshRecord,
  RefreshRecordSchema,
} from "@tila/schemas";
import {
  CredentialWriteRefusedError,
  ImmutableInstanceKeyError,
  InstanceKeyMismatchError,
  InstanceNotFoundError,
  InstanceNotTrustedError,
} from "./errors.js";
import { readInfraMeta, writeInfraMeta } from "./infra-file.js";
import type { TilaPaths } from "./paths.js";
import { readRegistry, writeRegistry } from "./registry-file.js";
import {
  type EnvProbe,
  type SecretStore,
  probeSecretStore,
} from "./secret-store.js";

// ----------------------------------------------------------------------------
// Public types
// ----------------------------------------------------------------------------

/**
 * Input for registerInstance. The caller supplies the resolved key and
 * declares its source — AuthStore pins the key immutably.
 */
export interface NewInstanceInput {
  /** The stable identifier for this instance. Pinned on first registration. */
  instance_key: InstanceKey;
  /** How the key was obtained — "server" (from instance_id) or "client-uuid". */
  instance_id_source: "server" | "client-uuid";
  /** The Worker URL for this instance. */
  worker_url: string;
  /** Human-readable label (optional). */
  label?: string;
}

/**
 * Composite view of a per-slug infra entry: non-secret meta from disk + secret
 * part from the keychain (null when absent).
 */
export interface InfraRecord {
  meta: PerSlugInfraMeta;
  secrets: InfraSecrets | null;
}

// ----------------------------------------------------------------------------
// Keychain service name constants
// ----------------------------------------------------------------------------

const SVC_CREDENTIAL = "tila:credential";
const SVC_REFRESH = "tila:refresh";
const SVC_INFRA = "tila:infra";

// ----------------------------------------------------------------------------
// AuthStore
// ----------------------------------------------------------------------------

export class AuthStore {
  private readonly paths: TilaPaths;
  private readonly secrets: SecretStore;
  private readonly env: EnvProbe;

  constructor(opts: { paths: TilaPaths; secrets: SecretStore; env: EnvProbe }) {
    this.paths = opts.paths;
    this.secrets = opts.secrets;
    this.env = opts.env;
  }

  // --------------------------------------------------------------------------
  // probe
  // --------------------------------------------------------------------------

  /**
   * Verify keychain accessibility via a sentinel round-trip.
   * Throws KeychainUnavailableError if the keychain is locked or unreachable.
   */
  async probe(): Promise<void> {
    await probeSecretStore(this.secrets);
  }

  // --------------------------------------------------------------------------
  // Tier 1: Registry
  // --------------------------------------------------------------------------

  /** Return all registered instances (empty list when registry is absent). */
  async listInstances(): Promise<InstanceRecord[]> {
    const registry = await readRegistry(this.paths);
    return registry?.instances ?? [];
  }

  /** Return the instance record for the given key, or null if not found. */
  async getInstance(key: InstanceKey): Promise<InstanceRecord | null> {
    const registry = await readRegistry(this.paths);
    if (!registry) return null;
    return registry.instances.find((r) => r.instance_key === key) ?? null;
  }

  /**
   * Register an instance, pinning the instance_key immutably.
   *
   * - If no record exists for the key: create one with trust.trusted = false.
   * - If a record exists with identical details: return it unchanged (idempotent).
   * - If a record exists with DIFFERENT details (e.g. different worker_url):
   *   throw ImmutableInstanceKeyError — re-keying/updating is not allowed.
   */
  async registerInstance(input: NewInstanceInput): Promise<InstanceRecord> {
    const registry = (await readRegistry(this.paths)) ?? {
      version: 1,
      current_context: null,
      instances: [],
    };

    const existing = registry.instances.find(
      (r) => r.instance_key === input.instance_key,
    );

    if (existing) {
      // A re-register is idempotent ONLY when the full immutable identity matches.
      // Pinned fields: instance_key (the lookup key), worker_url, instance_id_source.
      // Any difference in these fields is a conflict — throw ImmutableInstanceKeyError.
      // Note: `label` is mutable metadata; a label-only difference is silently ignored
      // and the existing record is returned unchanged (simpler than a partial update).
      if (
        existing.worker_url !== input.worker_url ||
        existing.instance_id_source !== input.instance_id_source
      ) {
        const conflict =
          existing.worker_url !== input.worker_url
            ? `worker_url "${existing.worker_url}" → "${input.worker_url}"`
            : `instance_id_source "${existing.instance_id_source}" → "${input.instance_id_source}"`;
        throw new ImmutableInstanceKeyError(
          input.instance_key,
          `Instance key "${input.instance_key}" is already registered — cannot re-register with conflicting ${conflict}`,
        );
      }
      // Idempotent: return the existing record unchanged
      return existing;
    }

    const now = Date.now();
    const newRecord: InstanceRecord = {
      instance_key: input.instance_key,
      instance_id_source: input.instance_id_source,
      worker_url: input.worker_url,
      ...(input.label !== undefined ? { label: input.label } : {}),
      trust: {
        trusted: false, // trust.trusted starts false; markTrusted() flips it
        trusted_at: null,
      },
      created_at: now,
    };

    registry.instances.push(newRecord);
    await writeRegistry(this.paths, registry);
    return newRecord;
  }

  /** Return the current_context key, or null when none is set. */
  async getCurrentContext(): Promise<InstanceKey | null> {
    const registry = await readRegistry(this.paths);
    return registry?.current_context ?? null;
  }

  /**
   * Set the current context to the given key, or clear it with null.
   * Throws InstanceNotFoundError if the key does not exist in the registry.
   */
  async setCurrentContext(key: InstanceKey | null): Promise<void> {
    const registry = (await readRegistry(this.paths)) ?? {
      version: 1,
      current_context: null,
      instances: [],
    };

    if (key !== null) {
      const exists = registry.instances.some((r) => r.instance_key === key);
      if (!exists) {
        throw new InstanceNotFoundError(key);
      }
    }

    registry.current_context = key;
    await writeRegistry(this.paths, registry);
  }

  /**
   * Remove an instance from the registry.
   *
   * - If the key does not exist: no-op (idempotent).
   * - If current_context points at the deleted key: clear it to null.
   * - No keychain interaction — keychain cleanup is the caller's responsibility.
   */
  async deleteInstance(key: InstanceKey): Promise<void> {
    const registry = await readRegistry(this.paths);
    if (!registry) return; // no registry → nothing to delete

    const filtered = registry.instances.filter((r) => r.instance_key !== key);
    if (filtered.length === registry.instances.length) return; // key not found → idempotent

    const newCurrentContext =
      registry.current_context === key ? null : registry.current_context;

    await writeRegistry(this.paths, {
      ...registry,
      instances: filtered,
      current_context: newCurrentContext,
    });
  }

  /**
   * Flip trust.trusted = true for the given instance and record trusted_at.
   * Throws InstanceNotFoundError if the key does not exist.
   */
  async markTrusted(key: InstanceKey): Promise<void> {
    const registry = await readRegistry(this.paths);
    if (!registry) {
      throw new InstanceNotFoundError(key);
    }

    const idx = registry.instances.findIndex((r) => r.instance_key === key);
    if (idx === -1) {
      throw new InstanceNotFoundError(key);
    }

    registry.instances[idx] = {
      ...registry.instances[idx],
      trust: {
        trusted: true,
        trusted_at: Date.now(),
      },
    };

    await writeRegistry(this.paths, registry);
  }

  // --------------------------------------------------------------------------
  // Tier 2: Credentials
  // --------------------------------------------------------------------------

  /**
   * Retrieve a credential for the given instance key.
   *
   * Returns null when:
   * - No credential exists in the keychain.
   * - The credential is expired (expires_at < Date.now()) unless allowExpired is true.
   *
   * Throws:
   * - KeychainUnavailableError when the keychain cannot be accessed.
   * - InstanceKeyMismatchError when the stored record's instance_key disagrees.
   */
  async getCredential(
    key: InstanceKey,
    opts?: { allowExpired?: boolean },
  ): Promise<CredentialRecord | null> {
    const raw = await this.secrets.get(SVC_CREDENTIAL, key);
    if (raw === null) return null;

    const parsed = CredentialRecordSchema.parse(JSON.parse(raw));

    // Binding check: the stored record must be bound to the lookup key
    if (parsed.instance_key !== key) {
      throw new InstanceKeyMismatchError(key, parsed.instance_key);
    }

    // Expiry check (default: filter expired unless allowExpired is set)
    if (!opts?.allowExpired && parsed.expires_at < Date.now()) {
      return null;
    }

    return parsed;
  }

  /**
   * Store a credential for an instance.
   *
   * Write ordering: the secret is written to the keychain BEFORE any registry
   * updates, so a crash leaves an orphaned-but-harmless keychain entry rather
   * than a dangling registry pointer.
   *
   * Throws:
   * - InstanceNotFoundError when the instance does not exist.
   * - InstanceNotTrustedError when the instance's trust.trusted !== true.
   * - CredentialWriteRefusedError under CI or non-TTY.
   * - KeychainUnavailableError when the keychain probe fails.
   */
  async putCredential(key: InstanceKey, rec: CredentialRecord): Promise<void> {
    await this.#assertTrusted(key);
    await this.#assertWriteAllowed();
    await probeSecretStore(this.secrets); // single-use probe before each write
    // SECRET written first (write-ordering invariant)
    await this.secrets.set(SVC_CREDENTIAL, key, JSON.stringify(rec));
  }

  /** Delete a credential entry. Does not throw if absent. */
  async deleteCredential(key: InstanceKey): Promise<void> {
    await this.secrets.delete(SVC_CREDENTIAL, key);
  }

  // --------------------------------------------------------------------------
  // Tier 3: Refresh tokens
  // --------------------------------------------------------------------------

  /**
   * Retrieve a refresh token for the given instance key.
   *
   * Same rules as getCredential (expiry, binding, keychain error propagation).
   */
  async getRefresh(
    key: InstanceKey,
    opts?: { allowExpired?: boolean },
  ): Promise<RefreshRecord | null> {
    const raw = await this.secrets.get(SVC_REFRESH, key);
    if (raw === null) return null;

    const parsed = RefreshRecordSchema.parse(JSON.parse(raw));

    // Binding check
    if (parsed.instance_key !== key) {
      throw new InstanceKeyMismatchError(key, parsed.instance_key);
    }

    // Expiry check (null expires_at = non-expiring)
    if (
      !opts?.allowExpired &&
      parsed.expires_at !== null &&
      parsed.expires_at < Date.now()
    ) {
      return null;
    }

    return parsed;
  }

  /**
   * Store a refresh token for an instance.
   *
   * Same trust + write-ordering rules as putCredential.
   */
  async putRefresh(key: InstanceKey, rec: RefreshRecord): Promise<void> {
    await this.#assertTrusted(key);
    await this.#assertWriteAllowed();
    await probeSecretStore(this.secrets); // single-use probe before each write
    // SECRET written first (write-ordering invariant)
    await this.secrets.set(SVC_REFRESH, key, JSON.stringify(rec));
  }

  /** Delete a refresh token entry. Does not throw if absent. */
  async deleteRefresh(key: InstanceKey): Promise<void> {
    await this.secrets.delete(SVC_REFRESH, key);
  }

  // --------------------------------------------------------------------------
  // Tier 4: Infra (non-secret meta on disk + secret part in keychain)
  // --------------------------------------------------------------------------

  /**
   * Retrieve the infra record for a slug, composing disk meta + keychain secrets.
   *
   * Returns null when no infra meta file exists for the slug.
   * Returns { meta, secrets: null } when the meta exists but no keychain secret.
   */
  async getInfra(slug: string): Promise<InfraRecord | null> {
    const meta = await readInfraMeta(this.paths, slug);
    if (meta === null) return null;

    const raw = await this.secrets.get(SVC_INFRA, slug);
    const secrets =
      raw !== null ? InfraSecretsSchema.parse(JSON.parse(raw)) : null;

    return { meta, secrets };
  }

  /**
   * Store an infra record for a slug.
   *
   * Write ordering: secrets are written to the keychain BEFORE the meta is
   * written to disk (same invariant as credential writes — crash-safe).
   *
   * Infra secrets are equally sensitive as credential secrets — apply the same
   * fail-closed guards (assertWriteAllowed + probeSecretStore) before any
   * keychain write. The probe is only needed when there are secrets to write.
   */
  async putInfra(slug: string, rec: InfraRecord): Promise<void> {
    if (rec.secrets !== null) {
      // Apply the same CI/non-TTY fail-closed guard used by putCredential/putRefresh
      this.#assertWriteAllowed();
      await probeSecretStore(this.secrets); // single-use probe before each write
      // SECRET written first (write-ordering invariant)
      await this.secrets.set(SVC_INFRA, slug, JSON.stringify(rec.secrets));
    }
    await writeInfraMeta(this.paths, slug, rec.meta);
  }

  /**
   * List all infra slugs that have a meta file on disk.
   *
   * Returns an empty list when the infra directory does not exist.
   */
  async listInfra(): Promise<string[]> {
    const infraDir = this.paths.infraDir();
    if (!existsSync(infraDir)) return [];

    const entries = readdirSync(infraDir);
    return entries
      .filter((name) => name.endsWith(".toml"))
      .map((name) => name.slice(0, -5)); // strip ".toml" suffix
  }

  // --------------------------------------------------------------------------
  // Private helpers
  // --------------------------------------------------------------------------

  /**
   * Assert that the instance identified by key exists and has trust.trusted = true.
   * Throws InstanceNotFoundError or InstanceNotTrustedError.
   */
  async #assertTrusted(key: InstanceKey): Promise<void> {
    const instance = await this.getInstance(key);
    if (instance === null) {
      throw new InstanceNotFoundError(key);
    }
    if (!instance.trust.trusted) {
      throw new InstanceNotTrustedError(key);
    }
  }

  /**
   * Assert that a secret write is permitted in the current environment.
   * Throws CredentialWriteRefusedError under CI or non-TTY.
   */
  #assertWriteAllowed(): void {
    if (this.env.isCI) {
      throw new CredentialWriteRefusedError("ci");
    }
    if (!this.env.isTTY) {
      throw new CredentialWriteRefusedError("non-tty");
    }
  }
}
