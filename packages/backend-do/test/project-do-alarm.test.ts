import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {},
}));

const reindexBatchMock = vi.fn();

vi.mock("@tila/ops-sqlite", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tila/ops-sqlite")>();
  return {
    ...actual,
    searchReindexOps: {
      ...actual.searchReindexOps,
      reindexBatch: reindexBatchMock,
    },
  };
});

const { ProjectDO } = await import("../src/project-do");

describe("ProjectDO.alarm", () => {
  it("stops re-arming, clears state, and writes a terminal marker after the retry cap", async () => {
    reindexBatchMock.mockReturnValue({ processed: 50, done: false });

    const storage = {
      get: vi.fn().mockResolvedValue({
        kind: "artifact",
        batchSize: 50,
        processed: 100,
        attempts: 99,
        startedAt: Date.now() - 60_000,
      }),
      put: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
      setAlarm: vi.fn().mockResolvedValue(undefined),
    };

    await ProjectDO.prototype.alarm.call({
      ctx: { storage },
      db: {},
    });

    expect(storage.delete).toHaveBeenCalledWith("_reindex_state");
    expect(storage.put).toHaveBeenCalledWith(
      "_reindex_failed",
      expect.objectContaining({
        kind: "artifact",
        reason: expect.any(String),
      }),
    );
    expect(storage.setAlarm).not.toHaveBeenCalled();
  });
});
