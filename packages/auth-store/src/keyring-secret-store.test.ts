/**
 * Tests for KeyringSecretStore.
 *
 * Structure:
 * 1. Non-gated unit tests — exercise the REAL SecretStore.get/set/delete method
 *    bodies via an injected stub entry factory. These always run and provide
 *    genuine coverage of the fail-closed contract (null-vs-throw distinction).
 * 2. Gated smoke test — a real OS keychain round-trip that is skipped when
 *    the keychain is unavailable (CI, locked, no keychain daemon).
 */

import { beforeAll, describe, expect, it } from "vitest";
import { KeychainUnavailableError } from "./errors.js";
import {
  type KeyringEntryLike,
  KeyringSecretStore,
} from "./keyring-secret-store.js";

// ---------------------------------------------------------------------------
// Unit tests — no real keychain required
// ---------------------------------------------------------------------------
// Unit tests inject a stub entry factory into KeyringSecretStore so the REAL
// get/set/delete method bodies run. No subclass override — the real try/catch,
// null-coercion, and error-mapping logic is what is under test.

type StubOpts = {
  /** What getPassword() resolves to (or throws if getThrows is set). */
  passwordReturn?: string | null | undefined;
  getThrows?: Error;
  setThrows?: Error;
  deleteThrows?: Error;
  /** What deleteCredential() resolves to (default: false = absent). */
  deleteReturns?: boolean;
};

function makeStubStore(opts: StubOpts = {}): KeyringSecretStore {
  const stubEntry: KeyringEntryLike = {
    async getPassword() {
      if (opts.getThrows) throw opts.getThrows;
      return opts.passwordReturn;
    },
    async setPassword(_secret: string) {
      if (opts.setThrows) throw opts.setThrows;
    },
    async deleteCredential() {
      if (opts.deleteThrows) throw opts.deleteThrows;
      return opts.deleteReturns ?? false;
    },
  };
  return new KeyringSecretStore(() => stubEntry);
}

describe("KeyringSecretStore (unit — no real keychain)", () => {
  describe("get", () => {
    it("returns null when entry is absent (getPassword returns null)", async () => {
      expect(
        await makeStubStore({ passwordReturn: null }).get("s", "a"),
      ).toBeNull();
    });

    it("returns null when entry is absent (getPassword returns undefined)", async () => {
      expect(
        await makeStubStore({ passwordReturn: undefined }).get("s", "a"),
      ).toBeNull();
    });

    it("returns the secret string when entry exists", async () => {
      expect(
        await makeStubStore({ passwordReturn: "my-secret" }).get("s", "a"),
      ).toBe("my-secret");
    });

    it("throws KeychainUnavailableError(get) when getPassword rejects", async () => {
      const nativeErr = new Error("keychain locked");
      const store = makeStubStore({ getThrows: nativeErr });
      await expect(store.get("s", "a")).rejects.toMatchObject({
        code: "KEYCHAIN_UNAVAILABLE",
        step: "get",
        cause: nativeErr,
      });
    });

    it("thrown error is an instanceof KeychainUnavailableError", async () => {
      const store = makeStubStore({ getThrows: new Error("locked") });
      await expect(store.get("s", "a")).rejects.toBeInstanceOf(
        KeychainUnavailableError,
      );
    });
  });

  describe("set", () => {
    it("resolves when setPassword succeeds", async () => {
      const store = makeStubStore();
      await expect(store.set("s", "a", "secret")).resolves.toBeUndefined();
    });

    it("throws KeychainUnavailableError(set) when setPassword rejects", async () => {
      const nativeErr = new Error("access denied");
      const store = makeStubStore({ setThrows: nativeErr });
      await expect(store.set("s", "a", "x")).rejects.toMatchObject({
        code: "KEYCHAIN_UNAVAILABLE",
        step: "set",
        cause: nativeErr,
      });
    });
  });

  describe("delete", () => {
    it("resolves when deleteCredential succeeds (entry present → true)", async () => {
      const store = makeStubStore({ deleteReturns: true });
      await expect(store.delete("s", "a")).resolves.toBeUndefined();
    });

    it("resolves when deleteCredential returns false (entry absent)", async () => {
      const store = makeStubStore({ deleteReturns: false });
      await expect(store.delete("s", "a")).resolves.toBeUndefined();
    });

    it("throws KeychainUnavailableError(delete) when deleteCredential rejects", async () => {
      const nativeErr = new Error("permission denied");
      const store = makeStubStore({ deleteThrows: nativeErr });
      await expect(store.delete("s", "a")).rejects.toMatchObject({
        code: "KEYCHAIN_UNAVAILABLE",
        step: "delete",
        cause: nativeErr,
      });
    });
  });

  describe("contract: null is ONLY for confirmed-absent entries", () => {
    it("never returns null when get throws — throws instead", async () => {
      const store = makeStubStore({ getThrows: new Error("daemon down") });
      // Must NOT return null — must throw
      let threw = false;
      try {
        await store.get("s", "a");
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// Gated smoke test — real OS keychain round-trip.
// Skipped when the keychain is unavailable (locked, no daemon, CI, etc.)
// ---------------------------------------------------------------------------

describe("KeyringSecretStore (smoke — real OS keychain)", () => {
  let available = false;

  beforeAll(async () => {
    const { KeyringSecretStore: K } = await import("./keyring-secret-store.js");
    const { probeSecretStore } = await import("./secret-store.js");
    const store = new K();
    try {
      await probeSecretStore(store);
      available = true;
    } catch {
      available = false;
    }
  });

  it("round-trips a credential through the OS keychain", async () => {
    if (!available) return;
    const store = new KeyringSecretStore();
    const service = "tila:__smoke_test__";
    const account = `__smoke_${Date.now()}__`;
    const secret = `smoke-secret-${Math.random()}`;

    // Clean up any leftover from a previous failed run
    await store.delete(service, account);

    // set
    await store.set(service, account, secret);

    // get — must return the exact secret
    const got = await store.get(service, account);
    expect(got).toBe(secret);

    // delete
    await store.delete(service, account);

    // get after delete — must return null
    const afterDelete = await store.get(service, account);
    expect(afterDelete).toBeNull();
  });

  it("get returns null for a nonexistent entry (no throw)", async () => {
    if (!available) return;
    const store = new KeyringSecretStore();
    const result = await store.get(
      "tila:__smoke_test__",
      `__nonexistent_${Date.now()}__`,
    );
    expect(result).toBeNull();
  });

  it("delete on a nonexistent entry does not throw", async () => {
    if (!available) return;
    const store = new KeyringSecretStore();
    await expect(
      store.delete("tila:__smoke_test__", `__nonexistent_${Date.now()}__`),
    ).resolves.toBeUndefined();
  });
});
