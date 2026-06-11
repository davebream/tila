import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("fence guard anti-patterns", () => {
  it("does not reintroduce fail-open `if (fenceRow)` checks in critical ops", () => {
    const files = ["../src/coordination-ops.ts", "../src/record-ops.ts"];

    for (const relativePath of files) {
      const source = readFileSync(
        join(import.meta.dirname, relativePath),
        "utf8",
      );
      expect(source).not.toMatch(/\bif\s*\(\s*fenceRow\s*\)/);
    }
  });
});
