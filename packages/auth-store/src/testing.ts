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
  private readonly store = new Map<string, string>();

  private key(service: string, account: string): string {
    return `${service}\x00${account}`;
  }

  async get(service: string, account: string): Promise<string | null> {
    return this.store.get(this.key(service, account)) ?? null;
  }

  async set(service: string, account: string, secret: string): Promise<void> {
    this.store.set(this.key(service, account), secret);
  }

  async delete(service: string, account: string): Promise<void> {
    this.store.delete(this.key(service, account));
  }
}

export type ThrowMode = "all" | "get" | "set" | "delete";

/**
 * A `SecretStore` that throws on the specified operations, modeling a locked
 * or inaccessible keychain. Use to verify that callers propagate
 * `KeychainUnavailableError` and never return `null` on access failure.
 *
 * When mode is "all", all operations throw.
 * When mode is one of "get" | "set" | "delete", only that operation throws;
 * the others delegate to an inner `FakeSecretStore`.
 */
export class ThrowingSecretStore implements SecretStore {
  private readonly inner = new FakeSecretStore();

  constructor(private readonly mode: ThrowMode = "all") {}

  private throwError(op: string): never {
    throw new Error(`ThrowingSecretStore: ${op} is configured to throw`);
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
