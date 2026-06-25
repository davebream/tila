import { describe, expect, it } from "vitest";
import { KeychainUnavailableError } from "./errors.js";
import { probeSecretStore } from "./secret-store.js";
import { FakeSecretStore, ThrowingSecretStore } from "./testing.js";

const PROBE_SERVICE = "tila:__probe__";
const PROBE_ACCOUNT = "__sentinel__";

describe("probeSecretStore", () => {
  it("succeeds with FakeSecretStore and deletes the sentinel", async () => {
    const store = new FakeSecretStore();

    await probeSecretStore(store);

    // Sentinel should have been deleted after a successful probe
    const remaining = await store.get(PROBE_SERVICE, PROBE_ACCOUNT);
    expect(remaining).toBeNull();
  });

  it("throws KeychainUnavailableError with step='set' when set throws", async () => {
    const store = new ThrowingSecretStore("set");

    await expect(probeSecretStore(store)).rejects.toSatisfy(
      (e: unknown) => e instanceof KeychainUnavailableError && e.step === "set",
    );
  });

  it("throws KeychainUnavailableError with step='get' when get returns null", async () => {
    // A store where set works but get always returns null
    const store = new FakeSecretStore();
    const originalGet = store.get.bind(store);
    store.get = async (_service: string, _account: string) => null;

    await expect(probeSecretStore(store)).rejects.toSatisfy(
      (e: unknown) => e instanceof KeychainUnavailableError && e.step === "get",
    );

    // Restore
    store.get = originalGet;
  });

  it("throws KeychainUnavailableError with step='get' when get throws", async () => {
    const store = new ThrowingSecretStore("get");

    await expect(probeSecretStore(store)).rejects.toSatisfy(
      (e: unknown) => e instanceof KeychainUnavailableError && e.step === "get",
    );
  });

  it("throws KeychainUnavailableError with step='assert' when read-back mismatches", async () => {
    // A store that stores a different value than what was written
    const store = new FakeSecretStore();
    const originalSet = store.set.bind(store);
    store.set = async (service: string, account: string, _secret: string) => {
      await originalSet(service, account, "wrong-value");
    };

    await expect(probeSecretStore(store)).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof KeychainUnavailableError && e.step === "assert",
    );
  });

  it("throws KeychainUnavailableError with step='delete' when delete throws", async () => {
    const store = new ThrowingSecretStore("delete");

    await expect(probeSecretStore(store)).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof KeychainUnavailableError && e.step === "delete",
    );
  });
});

describe("FakeSecretStore", () => {
  it("returns null for absent entries", async () => {
    const store = new FakeSecretStore();
    const result = await store.get("svc", "acct");
    expect(result).toBeNull();
  });

  it("round-trips a secret", async () => {
    const store = new FakeSecretStore();
    await store.set("svc", "acct", "my-secret");
    const result = await store.get("svc", "acct");
    expect(result).toBe("my-secret");
  });

  it("deletes an entry", async () => {
    const store = new FakeSecretStore();
    await store.set("svc", "acct", "my-secret");
    await store.delete("svc", "acct");
    const result = await store.get("svc", "acct");
    expect(result).toBeNull();
  });

  it("isolates entries by (service, account) composite key", async () => {
    const store = new FakeSecretStore();
    await store.set("svc-a", "acct", "secret-a");
    await store.set("svc-b", "acct", "secret-b");
    expect(await store.get("svc-a", "acct")).toBe("secret-a");
    expect(await store.get("svc-b", "acct")).toBe("secret-b");
  });
});

describe("ThrowingSecretStore", () => {
  it("throws on get when mode is 'all'", async () => {
    const store = new ThrowingSecretStore("all");
    await expect(store.get("svc", "acct")).rejects.toThrow();
  });

  it("throws on set when mode is 'all'", async () => {
    const store = new ThrowingSecretStore("all");
    await expect(store.set("svc", "acct", "secret")).rejects.toThrow();
  });

  it("throws on delete when mode is 'all'", async () => {
    const store = new ThrowingSecretStore("all");
    await expect(store.delete("svc", "acct")).rejects.toThrow();
  });

  it("only throws on set when mode is 'set'", async () => {
    const store = new ThrowingSecretStore("set");
    await expect(store.set("svc", "acct", "secret")).rejects.toThrow();
    // get and delete should work via underlying FakeSecretStore
    await expect(store.get("svc", "acct")).resolves.toBeNull();
  });

  it("only throws on get when mode is 'get'", async () => {
    const store = new ThrowingSecretStore("get");
    await expect(store.get("svc", "acct")).rejects.toThrow();
    // set should work
    await expect(store.set("svc", "acct", "secret")).resolves.toBeUndefined();
  });

  it("only throws on delete when mode is 'delete'", async () => {
    const store = new ThrowingSecretStore("delete");
    // set should work (stores in inner store)
    await store.set("svc", "acct", "secret");
    await expect(store.delete("svc", "acct")).rejects.toThrow();
    // get should work
    await expect(store.get("svc", "acct")).resolves.toBe("secret");
  });
});
