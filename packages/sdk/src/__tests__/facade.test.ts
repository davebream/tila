import { describe, expect, it, vi } from "vitest";
import { TilaClient } from "../client";
import { buildHttpFacadeForTest } from "../client";
import { createIndexMethods } from "../indexes";

/**
 * C4 — facade indexes reachability.
 * Asserts `facade.indexes` is defined and exposes the createIndexMethods surface.
 */
describe("TilaFacade.indexes (C4)", () => {
  it("facade.indexes is defined and has the expected methods", () => {
    const client = new TilaClient({ baseUrl: "https://api.test", token: "t" });
    const facade = buildHttpFacadeForTest(client, "proj-1");

    expect(facade.indexes).toBeDefined();
    expect(typeof facade.indexes.create).toBe("function");
    expect(typeof facade.indexes.addEntry).toBe("function");
    expect(typeof facade.indexes.listEntries).toBe("function");
  });
});
