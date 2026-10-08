import { afterEach, describe, expect, it, vi } from "vitest";
import { createHttpDriver } from "../src/drivers/http";

afterEach(() => vi.unstubAllGlobals());

function driver() {
  return createHttpDriver({
    runId: "store-sampling",
    baseUrl: "http://localhost:8787",
    token: "test-token",
    projectId: "test-project",
  });
}

describe("HTTP store sampling", () => {
  it.each([8192, 0, null, undefined])(
    "reads nested counts and database bytes (%s)",
    async (db_bytes) => {
      const fetchMock = vi.fn().mockResolvedValue(
        Response.json({
          counts: { domain: { entities: 3, journal: 7 }, schemaHistory: 2 },
          ...(db_bytes === undefined ? {} : { db_bytes }),
        }),
      );
      vi.stubGlobal("fetch", fetchMock);

      expect(await driver().sampleStore?.()).toEqual({
        db_bytes: db_bytes ?? null,
        counts: { entities: 3, journal: 7, _schema_history: 2 },
      });
      expect(fetchMock).toHaveBeenCalledWith(
        "http://localhost:8787/projects/test-project/admin/store-counts",
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: "Bearer test-token",
          }),
        }),
      );
    },
  );

  it.each([403, 500])(
    "rejects HTTP %s without returning an empty sample",
    async (status) => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(new Response(null, { status })),
      );
      await expect(driver().sampleStore?.()).rejects.toThrow(
        `store-counts failed: HTTP ${status}`,
      );
    },
  );

  it("rejects malformed counts instead of silently reporting an empty sample", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ domain: { entities: 3 } })),
    );
    await expect(driver().sampleStore?.()).rejects.toThrow();
  });
});
