/**
 * KeyringSecretStore — native OS keychain backend for @tila/auth-store.
 *
 * ## Spike outcome (2026-06-25)
 * @napi-rs/keyring was spiked under both Node (v25.6.0) and Bun (v1.2.7)
 * on macOS darwin-arm64. Both runtimes completed a set/get/delete round-trip
 * against the macOS Keychain successfully (EXIT: 0). The OS keychain was
 * accessible in this environment. Decision: use native @napi-rs/keyring.
 * No shell-out fallback is needed.
 *
 * ## SecretStore.get contract (enforced here)
 * `get` returns `null` ONLY for a confirmed-absent entry.
 * Any access failure (locked keychain, OS error, ambiguous credential)
 * MUST throw `KeychainUnavailableError` — never return null on failure.
 *
 * ## Keychain keys used by tila
 * - service `tila:credential` / account = instance slug or URL  → access token
 * - service `tila:refresh`    / account = instance slug or URL  → refresh token
 * - service `tila:infra`      / account = instance slug         → infra passphrase
 * - service `tila:__probe__`  / account = `__sentinel__`        → availability probe
 */

import { AsyncEntry } from "@napi-rs/keyring";
import { KeychainUnavailableError } from "./errors.js";
import type { SecretStore } from "./secret-store.js";

/**
 * Minimal interface matching the @napi-rs/keyring AsyncEntry surface used by
 * KeyringSecretStore. Extracted so tests can inject a stub without touching
 * the real OS keychain.
 */
export interface KeyringEntryLike {
  getPassword(): Promise<string | null | undefined>;
  setPassword(secret: string): Promise<void>;
  deleteCredential(): Promise<boolean>;
}

/** Factory that produces a KeyringEntryLike for a given service + account pair. */
export type KeyringEntryFactory = (
  service: string,
  account: string,
) => KeyringEntryLike;

/** Default factory wired to the real @napi-rs/keyring AsyncEntry. */
const defaultEntryFactory: KeyringEntryFactory = (service, account) =>
  new AsyncEntry(service, account);

export class KeyringSecretStore implements SecretStore {
  private readonly makeEntry: KeyringEntryFactory;

  constructor(makeEntry: KeyringEntryFactory = defaultEntryFactory) {
    this.makeEntry = makeEntry;
  }

  /**
   * Retrieve the stored secret.
   *
   * Returns `null` when the entry is confirmed absent.
   * Throws `KeychainUnavailableError` on any access failure.
   */
  async get(service: string, account: string): Promise<string | null> {
    try {
      const entry = this.makeEntry(service, account);
      const result = await entry.getPassword();
      // @napi-rs/keyring returns null (runtime) / undefined (types) when absent
      if (result === null || result === undefined) {
        return null;
      }
      return result;
    } catch (err) {
      throw new KeychainUnavailableError("get", err);
    }
  }

  /**
   * Store a secret.
   *
   * Throws `KeychainUnavailableError` on any write failure.
   */
  async set(service: string, account: string, secret: string): Promise<void> {
    try {
      const entry = this.makeEntry(service, account);
      await entry.setPassword(secret);
    } catch (err) {
      throw new KeychainUnavailableError("set", err);
    }
  }

  /**
   * Delete a secret entry.
   *
   * Does not throw if the entry is absent (returns false from the native lib,
   * which we swallow). Throws `KeychainUnavailableError` on access failures.
   */
  async delete(service: string, account: string): Promise<void> {
    try {
      const entry = this.makeEntry(service, account);
      await entry.deleteCredential();
      // deleteCredential returns false when entry is absent — that is fine per
      // the SecretStore contract ("does not throw if the entry is absent").
    } catch (err) {
      throw new KeychainUnavailableError("delete", err);
    }
  }
}
