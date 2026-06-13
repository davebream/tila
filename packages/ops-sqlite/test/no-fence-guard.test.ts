import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Every ops module that performs a required-fence destructive write must fail
// closed when the fence row is missing (via assertResourceFence /
// FenceNotFoundError) and must NOT reintroduce a fail-open `if (fenceRow)`
// best-effort guard. This source scan covers ALL FIVE fenced ops modules so a
// regression in any one is caught — previously only coordination-ops and
// record-ops were scanned (entity, gate, and artifact ops were unguarded).
const FENCED_MODULES = [
  "coordination-ops.ts",
  "record-ops.ts",
  "entity-ops.ts",
  "gate-ops.ts",
  "artifact-ops.ts",
];

describe("fence guard anti-patterns", () => {
  it.each(FENCED_MODULES)(
    "%s does not reintroduce a fail-open `if (fenceRow)` check",
    (name) => {
      const source = readFileSync(
        join(import.meta.dirname, "../src", name),
        "utf8",
      );
      expect(source).not.toMatch(/\bif\s*\(\s*fenceRow\s*\)/);
    },
  );
});
