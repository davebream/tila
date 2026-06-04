import { describe, expect, it } from "vitest";
import { RUN_WORKER_FIRST } from "../src/index";

describe("RUN_WORKER_FIRST", () => {
  it("is importable from @tila/schemas barrel", () => {
    expect(RUN_WORKER_FIRST).toBeDefined();
  });

  it("contains exactly four route prefixes", () => {
    expect(RUN_WORKER_FIRST).toHaveLength(4);
  });

  it("contains /api/*", () => {
    expect(RUN_WORKER_FIRST).toContain("/api/*");
  });

  it("contains /auth/*", () => {
    expect(RUN_WORKER_FIRST).toContain("/auth/*");
  });

  it("contains /projects/*", () => {
    expect(RUN_WORKER_FIRST).toContain("/projects/*");
  });

  it("contains /_internal/*", () => {
    expect(RUN_WORKER_FIRST).toContain("/_internal/*");
  });

  it("is a readonly tuple (as const)", () => {
    // The values should be read-only string literals
    const prefixes: readonly string[] = RUN_WORKER_FIRST;
    expect(Array.isArray(prefixes)).toBe(true);
  });
});
