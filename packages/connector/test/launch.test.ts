import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { type LaunchDriver, NativeLaunch } from "../src/launch";
import { ConnectorStore } from "../src/store";

it("keeps ambiguous launches pending across restart and reconciles only discovered native identity", async () => {
  const root = mkdtempSync("/tmp/tila-launch-");
  try {
    const store = new ConnectorStore(root);
    const verify = vi.fn(async () => ({
      profile_id: "one",
      profile_revision: 1,
      account_ref: "redacted",
      verification: "declared" as const,
    }));
    const driver: LaunchDriver = {
      discover: vi.fn(async () => null),
      spawn: vi.fn(async () => {
        throw new Error("connection lost after spawn");
      }),
    };
    const request = {
      operationId: randomUUID(),
      agent: "worker",
      profile: "one",
      profileRevision: 1,
      namespace: '["https://tila.test","project"]',
      sessionId: randomUUID(),
    };
    await expect(
      new NativeLaunch(store, { verify }, driver).open(request),
    ).rejects.toThrow("connection lost");
    const restarted = new NativeLaunch(store, { verify }, driver);
    expect((await restarted.open(request)).state).toBe("uncertain");
    expect(driver.spawn).toHaveBeenCalledTimes(1);
    vi.mocked(driver.discover).mockResolvedValue("a".repeat(64));
    expect(await restarted.open(request)).toMatchObject({
      state: "running",
      discoveredKey: "a".repeat(64),
    });
    expect(driver.spawn).toHaveBeenCalledTimes(1);
    await expect(
      restarted.open({ ...request, agent: "other" }),
    ).rejects.toThrow("identity changed");
    verify.mockRejectedValueOnce(new Error("profile mismatch"));
    await expect(
      restarted.open({ ...request, operationId: randomUUID() }),
    ).rejects.toThrow("profile mismatch");
    expect(driver.spawn).toHaveBeenCalledTimes(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
