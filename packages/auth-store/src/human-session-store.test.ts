import { describe, expect, it } from "vitest";
import { HumanSessionStore } from "./human-session-store";
import { FakeSecretStore } from "./testing";

describe("human login storage", () => {
  it("keeps login credentials separated by server and expires them", async () => {
    const store = new HumanSessionStore(new FakeSecretStore());
    const session = {
      token: "tila_u_test-login",
      expiresAt: Date.now() + 60_000,
    };
    await store.set("https://one.example", session);
    expect(await store.get("https://one.example/")).toEqual(session);
    expect(await store.get("https://two.example")).toBeNull();
    await store.set("https://one.example", { ...session, expiresAt: 0 });
    expect(await store.get("https://one.example")).toBeNull();
    await store.delete("https://one.example");
    expect(await store.get("https://one.example")).toBeNull();
  });
});
