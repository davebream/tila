import { describe, expect, it } from "vitest";
import { FenceError, assertFence, validateFence } from "../src/fence";

describe("validateFence", () => {
  it("returns true when claimed equals current", () => {
    expect(validateFence(5, 5)).toBe(true);
  });

  it("returns false when claimed is stale (less than current)", () => {
    expect(validateFence(5, 4)).toBe(false);
  });

  it("returns false when claimed is in the future (greater than current)", () => {
    expect(validateFence(5, 6)).toBe(false);
  });

  it("returns true for fence value 0", () => {
    expect(validateFence(0, 0)).toBe(true);
  });
});

describe("assertFence", () => {
  it("does not throw when fences match", () => {
    expect(() => assertFence(5, 5)).not.toThrow();
  });

  it("throws FenceError on mismatch", () => {
    expect(() => assertFence(5, 3)).toThrow(FenceError);
  });

  it("FenceError message contains both fence values", () => {
    try {
      assertFence(5, 3);
    } catch (e) {
      expect(e).toBeInstanceOf(FenceError);
      expect((e as FenceError).message).toContain("5");
      expect((e as FenceError).message).toContain("3");
      expect((e as FenceError).currentFence).toBe(5);
      expect((e as FenceError).claimedFence).toBe(3);
    }
  });
});
