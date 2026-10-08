import { describe, expect, it, vi } from "vitest";
import { sweepExpiredKey } from "./sweep-key";

describe("sweep deletion authorization", () => {
  it("does not delete bytes when the DO rejects tombstoning", async () => {
    const fetch = vi.fn(async () => new Response("busy", { status: 409 }));
    const remove = vi.fn(async () => {});
    const summary = { artifactsExpired: 0, r2DeleteErrors: 0 };
    expect(
      await sweepExpiredKey("produced/key", { fetch }, remove, summary),
    ).toBe(1);
    expect(remove).not.toHaveBeenCalled();
    expect(summary.r2DeleteErrors).toBe(1);
  });
  it("counts the actual retry and reports confirmation failures", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }));
    const remove = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary"))
      .mockResolvedValueOnce(undefined);
    const summary = { artifactsExpired: 0, r2DeleteErrors: 0 };
    expect(
      await sweepExpiredKey("produced/key", { fetch }, remove, summary),
    ).toBe(4);
    expect(summary).toEqual({ artifactsExpired: 1, r2DeleteErrors: 1 });
  });
});
