import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalProject } from "../../src/local-project";
import { spawnWorker } from "./helpers/spawn-helper";

describe("claim-race: multi-process acquire", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "tila-race-"));
    dbPath = join(tempDir, "race.db");

    // Pre-create the database with migrations so subprocesses don't race on migration
    const lp = LocalProject.open(dbPath, "test-org", "test-project", {
      skipFilesystemCheck: true,
    });
    lp.close();
  });

  afterEach(() => {
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it(
    "exactly one of N=5 concurrent processes wins the exclusive acquire",
    async () => {
      const N = 5;
      const resource = "race-resource";

      // Spawn N workers all targeting the same resource.
      // TILA_BUSY_TIMEOUT=100: short timeout so each retry cycle is fast (default 5000ms
      // would make the test take up to 25s for 5 retries per subprocess).
      const promises = Array.from({ length: N }, (_, i) =>
        spawnWorker("acquire", {
          TILA_DB_PATH: dbPath,
          TILA_RESOURCE: resource,
          TILA_HOLDER: `holder-${i}`,
          TILA_BUSY_TIMEOUT: "100",
        }),
      );

      const results = await Promise.all(promises);

      // All processes should exit cleanly
      for (const r of results) {
        expect(r.exitCode, `Subprocess failed with stderr: ${r.stderr}`).toBe(
          0,
        );
      }

      // Parse acquire results from stdout
      const acquireResults = results.map((r) => {
        const parsed = JSON.parse(r.stdout);
        return parsed as {
          acquired: boolean;
          fence: number;
          expires_at: number;
        };
      });

      // Exactly one should have acquired=true
      const winners = acquireResults.filter((r) => r.acquired);
      const losers = acquireResults.filter((r) => !r.acquired);

      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(N - 1);

      // The winner's fence should be > 0
      expect(winners[0].fence).toBeGreaterThan(0);
    },
    { retry: 3, timeout: 30000 },
  );
});
