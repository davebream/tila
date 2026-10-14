import { AsyncLocalStorage } from "node:async_hooks";
import {
  TilaClient,
  type TilaFacade,
  createSettingsTransferMethods,
} from "tila-sdk";
import { expect, it, vi } from "vitest";
import { scopedFacade } from "../lifecycle";
import { asFacade, createMockFacade } from "./helpers/mock-facade";

it("routes nested settings reads to interleaved request identities and preserves an absent local surface", async () => {
  const storage = new AsyncLocalStorage<TilaFacade>();
  const facade = scopedFacade(storage);
  let unblock: (() => void) | undefined;
  const blocked = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const identity = (principal: string) => ({
    ok: true as const,
    project_id: "destination",
    principal_id: principal,
    token_name: "fixture",
    scopes: "full",
    auth_kind: "d1-token" as const,
  });
  const build = (principal: string) => {
    const methods = createSettingsTransferMethods(
      new TilaClient({
        baseUrl: "https://worker",
        token: "fixture",
        participantId: principal,
      }),
      "destination",
    );
    const read = vi
      .spyOn(methods.read, "identity")
      .mockImplementation(async () => {
        if (principal === "A") await blocked;
        return identity(principal);
      });
    return {
      concrete: { ...asFacade(createMockFacade()), settingsTransfer: methods },
      read,
    };
  };
  const a = build("A");
  const b = build("B");
  const local = asFacade(createMockFacade());
  const first = storage.run(a.concrete, async () => {
    const reads = { ...facade.settingsTransfer?.read };
    if (!reads.identity) throw new Error("Missing scope A reader");
    expect(reads.identity).toBe(a.read);
    const result = await reads.identity();
    expect(facade.settingsTransfer?.read.identity).toBe(a.read);
    return result;
  });
  const second = await storage.run(b.concrete, async () => {
    expect(facade.settingsTransfer?.read.identity).toBe(b.read);
    return facade.settingsTransfer?.read.identity();
  });
  expect(second?.principal_id).toBe("B");
  storage.run(local, () => expect(facade.settingsTransfer).toBeUndefined());
  expect(a.read).toHaveBeenCalledOnce();
  expect(b.read).toHaveBeenCalledOnce();
  unblock?.();
  expect((await first).principal_id).toBe("A");
  storage.run(local, () => expect(facade.settingsTransfer).toBeUndefined());
});
