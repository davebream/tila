/**
 * Unit tests for sweepExpiredKey (C5 ordering invariant).
 *
 * Invariant: tombstone precedes R2 delete.
 * When r2.delete throws (even after one retry), the pointer must already be
 * tombstoned (non-live). There must be no live dangling pointer to a missing blob.
 * r2DeleteErrors is incremented on final delete failure.
 */
import { describe, expect, it, vi } from "vitest";
import { sweepExpiredKey } from "./lib/sweep-key";

type Summary = { artifactsExpired: number; r2DeleteErrors: number };

function makeSummary(): Summary {
  return { artifactsExpired: 0, r2DeleteErrors: 0 };
}

/** Creates a mock DO stub that records tombstone calls. */
function makeDoStub(opts?: {
  tombstoneShouldThrow?: boolean;
}) {
  const tombstonedKeys: string[] = [];
  const stub = {
    fetch: vi.fn(async (req: Request | string, init?: RequestInit) => {
      const url = typeof req === "string" ? req : req.url;
      if (url.includes("/artifact/tombstone")) {
        if (opts?.tombstoneShouldThrow) throw new Error("DO unreachable");
        // Parse r2_key from the body (passed either in init.body or req.body)
        let body: string | null = null;
        if (init?.body && typeof init.body === "string") {
          body = init.body;
        } else if (req instanceof Request) {
          body = await req.clone().text();
        }
        const parsed = body ? JSON.parse(body) : {};
        tombstonedKeys.push(parsed.r2_key ?? "unknown");
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }),
  };
  return { stub, tombstonedKeys };
}

describe("sweepExpiredKey — C5 tombstone-before-delete invariant", () => {
  it("happy path: tombstones then deletes, increments artifactsExpired", async () => {
    const { stub } = makeDoStub();
    const r2Delete = vi.fn(async () => {});
    const summary = makeSummary();

    await sweepExpiredKey("produced/a/abc.bin", stub, r2Delete, summary);

    expect(stub.fetch).toHaveBeenCalledTimes(1);
    const firstArg = stub.fetch.mock.calls[0][0] as string;
    expect(firstArg).toContain("/artifact/tombstone");
    expect(r2Delete).toHaveBeenCalledWith("produced/a/abc.bin");
    expect(summary.artifactsExpired).toBe(1);
    expect(summary.r2DeleteErrors).toBe(0);
  });

  it("r2.delete throws both attempts: pointer is tombstoned (non-live), r2DeleteErrors incremented", async () => {
    const { stub, tombstonedKeys } = makeDoStub();
    // Both delete attempts throw
    const r2Delete = vi
      .fn()
      .mockRejectedValueOnce(new Error("R2 delete failed"))
      .mockRejectedValueOnce(new Error("R2 delete failed (retry)"));
    const summary = makeSummary();

    await sweepExpiredKey("produced/b/def.bin", stub, r2Delete, summary);

    // Tombstone was called BEFORE delete — pointer is non-live
    expect(tombstonedKeys).toContain("produced/b/def.bin");
    // r2.delete was tried twice (original + 1 retry)
    expect(r2Delete).toHaveBeenCalledTimes(2);
    // artifactsExpired NOT incremented (delete failed)
    expect(summary.artifactsExpired).toBe(0);
    // r2DeleteErrors IS incremented
    expect(summary.r2DeleteErrors).toBe(1);
  });

  it("r2.delete first attempt throws, retry succeeds: artifactsExpired incremented", async () => {
    const { stub } = makeDoStub();
    const r2Delete = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValueOnce(undefined);
    const summary = makeSummary();

    await sweepExpiredKey("produced/c/ghi.bin", stub, r2Delete, summary);

    expect(r2Delete).toHaveBeenCalledTimes(2);
    expect(summary.artifactsExpired).toBe(1);
    expect(summary.r2DeleteErrors).toBe(0);
  });

  it("tombstone failure: r2.delete is NOT called, r2DeleteErrors incremented", async () => {
    const { stub } = makeDoStub({ tombstoneShouldThrow: true });
    const r2Delete = vi.fn();
    const summary = makeSummary();

    await sweepExpiredKey("produced/d/jkl.bin", stub, r2Delete, summary);

    // Tombstone failed — delete must not be called (avoids live pointer to missing blob)
    expect(r2Delete).not.toHaveBeenCalled();
    expect(summary.r2DeleteErrors).toBe(1);
    expect(summary.artifactsExpired).toBe(0);
  });

  it("tombstone is called BEFORE r2Delete (ordering invariant)", async () => {
    const callOrder: string[] = [];
    const { stub } = makeDoStub();
    // Override fetch to track order
    stub.fetch = vi.fn(async (req: Request | string) => {
      callOrder.push("tombstone");
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const r2Delete = vi.fn(async () => {
      callOrder.push("r2-delete");
    });
    const summary = makeSummary();

    await sweepExpiredKey("produced/e/mno.bin", stub, r2Delete, summary);

    expect(callOrder).toEqual(["tombstone", "r2-delete"]);
  });
});
