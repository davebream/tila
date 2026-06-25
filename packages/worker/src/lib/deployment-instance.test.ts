import { beforeEach, describe, expect, it, vi } from "vitest";

// ─── Mock D1DeploymentMetaStore ───────────────────────────────────────────────
// We mock the entire backend-d1 module so the worker wrapper's dependency on
// the store can be controlled without a real D1 binding or better-sqlite3.

let mockEnsureResult: string | null = null;
let mockEnsureShouldThrow = false;

// Define the error class independently to avoid hoisting issues with the mock factory.
class DeploymentIdUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeploymentIdUnavailable";
  }
}

vi.mock("@tila/backend-d1", () => {
  // Re-define within the factory (hoisted — cannot access outer-scope let/class)
  class MockDeploymentIdUnavailable extends Error {
    constructor(message: string) {
      super(message);
      this.name = "DeploymentIdUnavailable";
    }
  }

  return {
    D1DeploymentMetaStore: class {
      async ensure(): Promise<string> {
        if (mockEnsureShouldThrow) {
          throw new MockDeploymentIdUnavailable("D1 unavailable (test)");
        }
        if (mockEnsureResult === null) {
          throw new MockDeploymentIdUnavailable(
            "deployment instance_id unavailable: row absent after backfill INSERT",
          );
        }
        return mockEnsureResult;
      }
      async get(): Promise<string | null> {
        return mockEnsureResult;
      }
      async seed(_id: string): Promise<void> {}
    },
    DeploymentIdUnavailable: MockDeploymentIdUnavailable,
  };
});

import {
  __resetInstanceCache,
  ensureDeploymentInstanceId,
} from "./deployment-instance";

// Minimal D1Database stub (the wrapper only passes db to the store constructor;
// the store itself is mocked above, so the db object is never actually used).
const STUB_DB = {} as unknown as D1Database;

describe("ensureDeploymentInstanceId", () => {
  beforeEach(() => {
    // Reset per-isolate module-level cache between every test
    __resetInstanceCache();
    // Reset mock state
    mockEnsureResult = null;
    mockEnsureShouldThrow = false;
    vi.restoreAllMocks();
  });

  it("first call resolves via the store and returns the id", async () => {
    mockEnsureResult = "test-instance-abc";
    const id = await ensureDeploymentInstanceId(STUB_DB);
    expect(id).toBe("test-instance-abc");
  });

  it("second call returns cached value without a second store read", async () => {
    mockEnsureResult = "cached-id";

    // Track how many times the store's ensure() is called by instrumenting
    // the module mock after it is set up.
    const { D1DeploymentMetaStore } = await import("@tila/backend-d1");
    const ensureSpy = vi.spyOn(
      D1DeploymentMetaStore.prototype,
      "ensure" as keyof InstanceType<typeof D1DeploymentMetaStore>,
    );

    await ensureDeploymentInstanceId(STUB_DB); // first call — populates cache
    await ensureDeploymentInstanceId(STUB_DB); // second call — should hit cache

    // The store's ensure() should have been called exactly once
    expect(ensureSpy).toHaveBeenCalledTimes(1);
  });

  it("thrown error propagates out of the wrapper", async () => {
    mockEnsureShouldThrow = true;
    await expect(ensureDeploymentInstanceId(STUB_DB)).rejects.toThrow(
      "D1 unavailable (test)",
    );
  });

  it("throw is NOT cached — next call (after fix) retries and succeeds", async () => {
    // First call: store throws
    mockEnsureShouldThrow = true;
    await expect(ensureDeploymentInstanceId(STUB_DB)).rejects.toThrow();

    // Heal: next call should succeed without __resetInstanceCache()
    // because the throw must not have populated the cache.
    mockEnsureShouldThrow = false;
    mockEnsureResult = "healed-id";

    const id = await ensureDeploymentInstanceId(STUB_DB);
    expect(id).toBe("healed-id");
  });
});
