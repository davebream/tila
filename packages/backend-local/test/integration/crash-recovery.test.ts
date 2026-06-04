import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalProject } from "../../src/local-project";
import { spawnWorkerProcess } from "./helpers/spawn-helper";

describe("crash-recovery: SIGKILL mid-transaction leaves no partial state", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "tila-crash-"));
    dbPath = join(tempDir, "crash.db");

    // Pre-create the database with migrations
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
    "process killed mid-transaction leaves no partial claims or fences",
    async () => {
      const syncFile = join(tempDir, "sync-ready");
      const resource = "crash-test-resource";

      // Spawn a subprocess that opens a transaction and holds it open
      const proc = spawnWorkerProcess("acquire-hold", {
        TILA_DB_PATH: dbPath,
        TILA_RESOURCE: resource,
        TILA_HOLDER: "crash-holder",
        TILA_SYNC_FILE: syncFile,
      });

      // Wait for the sync file to appear (subprocess signals it is inside the transaction)
      const startTime = Date.now();
      const timeoutMs = 5000;
      while (!existsSync(syncFile)) {
        if (Date.now() - startTime > timeoutMs) {
          // Try to clean up
          proc.kill();
          throw new Error(
            `Subprocess did not signal ready within ${timeoutMs}ms`,
          );
        }
        await Bun.sleep(50);
      }

      // The subprocess is now inside an uncommitted transaction. Kill it.
      proc.kill(9); // SIGKILL -- no chance to commit

      // Wait for the process to actually exit
      await proc.exited;

      // Open a fresh connection to the same DB
      const lp = LocalProject.open(dbPath, "test-org", "test-project", {
        skipFilesystemCheck: true,
      });

      // The resource should have no claim (the uncommitted transaction was rolled back)
      const state = await lp.state(resource);
      expect(state).toBeNull();

      // Double-check: query the fences table directly
      const db = new Database(dbPath, { readonly: true });
      const fenceRow = db
        .query("SELECT current_fence FROM fences WHERE resource = ?")
        .get(resource) as { current_fence: number } | null;
      db.close();

      // Either no fence row exists, or the fence is from a prior committed operation (not 999999)
      if (fenceRow) {
        expect(fenceRow.current_fence).not.toBe(999999);
      }

      lp.close();
    },
    { timeout: 15000 },
  );
});
