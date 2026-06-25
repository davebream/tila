import { randomBytes } from "node:crypto";
import { KeychainUnavailableError } from "./errors.js";

/**
 * Runtime-agnostic keychain interface — the `BlobStore` analogue for secrets.
 *
 * **`get` contract (load-bearing):**
 * `get` returns `null` ONLY for a confirmed-absent entry.
 * Any failure to ACCESS the store (locked keychain, daemon down, OS error)
 * MUST throw `KeychainUnavailableError` — never return `null`.
 * This makes "no silent degradation" enforceable: a locked keychain on a read
 * cannot be mistaken for "no credential."
 *
 * Implementations must uphold this contract. The `FakeSecretStore` and
 * `ThrowingSecretStore` test doubles also honor it — see `testing.ts`.
 */
export interface SecretStore {
  /**
   * Returns the stored secret or null if the entry is confirmed absent.
   * Throws `KeychainUnavailableError` on any access failure.
   */
  get(service: string, account: string): Promise<string | null>;

  /** Stores a secret. */
  set(service: string, account: string, secret: string): Promise<void>;

  /** Deletes a secret entry. Does not throw if the entry is absent. */
  delete(service: string, account: string): Promise<void>;
}

/**
 * Probe the availability of a `SecretStore` via a sentinel round-trip.
 *
 * Writes a random nonce to `tila:__probe__` / `__sentinel__`, reads it back,
 * asserts byte-equality, then deletes it. Any failure at any step throws
 * `KeychainUnavailableError(step, cause)`.
 *
 * This probe is **single-use** — never cache the result across operations.
 * A >5s cache would reintroduce a TOCTOU where the keychain re-locks between
 * probe and write. Run before every secret write.
 */
export async function probeSecretStore(store: SecretStore): Promise<void> {
  const service = "tila:__probe__";
  const account = "__sentinel__";
  const nonce = randomBytes(16).toString("hex");

  // Step 1: write the nonce
  try {
    await store.set(service, account, nonce);
  } catch (err) {
    throw new KeychainUnavailableError("set", err);
  }

  // Step 2: read it back
  let readBack: string | null;
  try {
    readBack = await store.get(service, account);
  } catch (err) {
    // Clean up best-effort
    try {
      await store.delete(service, account);
    } catch {
      // ignore cleanup error
    }
    throw new KeychainUnavailableError("get", err);
  }

  // Step 3: assert byte equality
  // null read-back is treated as a "get" failure (keychain didn't return the entry)
  if (readBack === null) {
    try {
      await store.delete(service, account);
    } catch {
      // ignore cleanup error
    }
    throw new KeychainUnavailableError("get");
  }
  // Non-null but mismatched nonce is a byte-equality assertion failure
  if (readBack !== nonce) {
    try {
      await store.delete(service, account);
    } catch {
      // ignore cleanup error
    }
    throw new KeychainUnavailableError("assert");
  }

  // Step 4: delete the sentinel
  try {
    await store.delete(service, account);
  } catch (err) {
    throw new KeychainUnavailableError("delete", err);
  }
}

/**
 * Runtime environment probe for CI / TTY detection.
 *
 * Used by `AuthStore` to fail-closed on secret writes under CI or non-TTY.
 * Injected as a dependency so it can be faked in tests.
 */
export interface EnvProbe {
  /** True when running in a CI environment (e.g. CI=true env var). */
  isCI: boolean;
  /** True when stdin is a TTY. */
  isTTY: boolean;
}

/**
 * Default `EnvProbe` implementation reading from the current process.
 */
export const processEnvProbe: EnvProbe = {
  get isCI(): boolean {
    return Boolean(process.env.CI);
  },
  get isTTY(): boolean {
    return Boolean(process.stdin.isTTY);
  },
};
