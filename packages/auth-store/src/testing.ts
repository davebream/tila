import { KeychainUnavailableError } from "./errors.js";
import type { SecretStore } from "./secret-store.js";

/**
 * In-memory `SecretStore` for unit tests.
 *
 * Honors the `SecretStore.get` contract:
 * - `get` returns `null` for absent entries (not an error — genuinely absent)
 * - `get` never throws (the fake models a healthy, accessible keychain)
 *
 * Use `ThrowingSecretStore` to model a locked / inaccessible keychain.
 */
export class FakeSecretStore implements SecretStore {
  /** Exposed for test helpers that need to seed entries bypassing higher-level logic. */
  readonly _store = new Map<string, string>();

  private key(service: string, account: string): string {
    return `${service}\x00${account}`;
  }

  async get(service: string, account: string): Promise<string | null> {
    return this._store.get(this.key(service, account)) ?? null;
  }

  async set(service: string, account: string, secret: string): Promise<void> {
    this._store.set(this.key(service, account), secret);
  }

  async delete(service: string, account: string): Promise<void> {
    this._store.delete(this.key(service, account));
  }
}

export type ThrowMode = "all" | "get" | "set" | "delete";

/**
 * A `SecretStore` that throws `KeychainUnavailableError` on the specified
 * operations, modeling a locked or inaccessible keychain.
 *
 * Honors the `SecretStore.get` contract: access failures MUST throw
 * `KeychainUnavailableError`, never return `null`. Callers that receive a
 * throw from `get` must propagate it as `KeychainUnavailableError`, not
 * suppress it or return null.
 *
 * When mode is "all", all operations throw.
 * When mode is one of "get" | "set" | "delete", only that operation throws;
 * the others delegate to an inner `FakeSecretStore`.
 *
 * The inner `FakeSecretStore` is exposed as `inner` for tests that need to
 * pre-seed entries while still having `get` throw (modeling a keychain that
 * was previously accessible but is now locked).
 */
export class ThrowingSecretStore implements SecretStore {
  /** Inner fake — use to pre-seed entries when testing partial failure modes. */
  readonly inner = new FakeSecretStore();

  constructor(private readonly mode: ThrowMode = "all") {}

  private throwError(op: "set" | "get" | "assert" | "delete"): never {
    throw new KeychainUnavailableError(
      op,
      new Error(`ThrowingSecretStore: ${op} is configured to throw`),
    );
  }

  async get(service: string, account: string): Promise<string | null> {
    if (this.mode === "all" || this.mode === "get") {
      this.throwError("get");
    }
    return this.inner.get(service, account);
  }

  async set(service: string, account: string, secret: string): Promise<void> {
    if (this.mode === "all" || this.mode === "set") {
      this.throwError("set");
    }
    return this.inner.set(service, account, secret);
  }

  async delete(service: string, account: string): Promise<void> {
    if (this.mode === "all" || this.mode === "delete") {
      this.throwError("delete");
    }
    return this.inner.delete(service, account);
  }
}
