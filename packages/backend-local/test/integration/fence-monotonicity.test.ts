import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalProject } from "../../src/local-project";

describe("fence-monotonicity", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "tila-fence-"));
    dbPath = join(tempDir, "fence.db");
  });

  afterEach(() => {
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it(
    "10 sequential acquire-release cycles produce strictly increasing fences",
    async () => {
      const lp = LocalProject.open(dbPath, "test-org", "test-project", {
        skipFilesystemCheck: true,
      });

      const resource = "fence-test-resource";
      const fences: number[] = [];

      for (let i = 0; i < 10; i++) {
        const result = await lp.acquire(
          resource,
          `holder-${i}`,
          `holder-${i}`,
          "exclusive",
          60000,
        );
        expect(result.acquired).toBe(true);
        fences.push(result.fence);

        await lp.release(resource, result.fence);
      }

      // Assert strict monotonicity: each fence > previous fence
      for (let i = 1; i < fences.length; i++) {
        expect(
          fences[i],
          `Fence ${i} (${fences[i]}) should be > fence ${i - 1} (${fences[i - 1]})`,
        ).toBeGreaterThan(fences[i - 1]);
      }

      lp.close();
    },
    { timeout: 15000 },
  );

  it(
    "fence values are strictly increasing per resource across acquire-release cycles",
    async () => {
      const lp = LocalProject.open(dbPath, "test-org", "test-project", {
        skipFilesystemCheck: true,
      });

      // Fences are per-resource counters, not global.
      // Each resource has its own monotonically increasing fence sequence.
      const resources = ["res-a", "res-b", "res-c"];
      const fencesByResource: Record<string, number[]> = {};

      for (const resource of resources) {
        fencesByResource[resource] = [];
        for (let i = 0; i < 3; i++) {
          const result = await lp.acquire(
            resource,
            `holder-${i}`,
            `holder-${i}`,
            "exclusive",
            60000,
          );
          expect(result.acquired).toBe(true);
          fencesByResource[resource].push(result.fence);
          await lp.release(resource, result.fence);
        }
      }

      // Per-resource fences should be strictly increasing
      for (const resource of resources) {
        const fences = fencesByResource[resource];
        for (let i = 1; i < fences.length; i++) {
          expect(
            fences[i],
            `Resource ${resource}: fence[${i}] (${fences[i]}) should be > fence[${i - 1}] (${fences[i - 1]})`,
          ).toBeGreaterThan(fences[i - 1]);
        }
      }

      lp.close();
    },
    { timeout: 15000 },
  );
});
