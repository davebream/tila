import { afterEach, describe, expect, it } from "vitest";
import { createInprocDriver } from "../src/drivers/inproc";
import type { Driver } from "../src/types";

let driver: Driver;
afterEach(async () => {
  await driver?.cleanup();
});

describe("in-process driver", () => {
  it("routes the SDK facade through the Worker routes and DO router", async () => {
    driver = createInprocDriver({ runId: "t1" });
    const [a, b] = await driver.participants(2, 1);
    expect(a.principalId).toBe("token:bench");
    expect(b.participantId).not.toBe(a.participantId);

    const claim = await a.tila.claims.acquire("task:x", "exclusive", 10_000);
    expect(claim.ok).toBe(true);
    expect(claim.fence).toBeGreaterThan(0);

    await expect(
      b.tila.claims.acquire("task:x", "exclusive", 10_000),
    ).rejects.toMatchObject({
      status: 409,
      code: "already-held",
    });

    const renewed = await a.tila.claims.renew("task:x", claim.fence, 10_000);
    expect(renewed.ok).toBe(true);
    await a.tila.claims.release("task:x", claim.fence);
    const list = await a.tila.claims.list();
    expect(
      list.claims.find((c: { resource: string }) => c.resource === "task:x"),
    ).toBeUndefined();
  });

  it("distinguishes principals by bearer token and samples the store", async () => {
    driver = createInprocDriver({ runId: "t2" });
    const [a, b] = await driver.participants(2, 2);
    expect(a.principalId).toBe("token:bench-0");
    expect(b.principalId).toBe("token:bench-1");
    await a.tila.claims.acquire("owned", "owner", 10_000);
    await expect(
      b.tila.claims.acquire("owned", "owner", 10_000),
    ).rejects.toMatchObject({
      status: 409,
    });
    const sample = await driver.sampleStore?.();
    expect(sample?.counts.claims).toBe(1);
    expect(sample?.db_bytes).toBeGreaterThan(0);
    const sweep = await driver.sweep?.();
    expect(sweep?.claims_deleted).toBe(0);
  });

  it("rejects requests without a participant id, like production", async () => {
    driver = createInprocDriver({ runId: "t3" });
    const [a] = await driver.participants(1, 1);
    const res = await a.rawFetch?.("/projects/bench/presence/heartbeat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Tila-Participant-Id": "",
      },
      body: JSON.stringify({ info: {} }),
    });
    expect(res?.status).toBe(400);
  });
});
