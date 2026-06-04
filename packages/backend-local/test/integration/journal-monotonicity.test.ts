import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalProject } from "../../src/local-project";
import { spawnWorker } from "./helpers/spawn-helper";

describe("journal-monotonicity: concurrent writers produce strictly monotonic seq", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "tila-journal-"));
    dbPath = join(tempDir, "journal.db");

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
    "3 concurrent processes each creating N=3 entities produce strictly monotonic journal seq",
    async () => {
      const workerCount = 3;
      const entitiesPerWorker = 3; // 9 total entity creates across 3 concurrent processes

      // Spawn 3 workers, each creating 3 entities.
      // Do NOT override TILA_BUSY_TIMEOUT: use the default 5000ms SQLite busy_timeout
      // so concurrent writers wait for the lock rather than failing with SQLITE_BUSY.
      const promises = Array.from({ length: workerCount }, (_, i) =>
        spawnWorker("journal-append", {
          TILA_DB_PATH: dbPath,
          TILA_HOLDER: `writer-${i}`,
          TILA_N: String(entitiesPerWorker),
        }),
      );

      const results = await Promise.all(promises);

      // All should exit cleanly
      for (const r of results) {
        expect(r.exitCode, `Subprocess failed: ${r.stderr}`).toBe(0);
      }

      // Query the journal table directly via raw bun:sqlite
      const db = new Database(dbPath, { readonly: true });
      const rows = db
        .query("SELECT seq FROM journal ORDER BY seq ASC")
        .all() as { seq: number }[];
      db.close();

      // Expect at least workerCount * entitiesPerWorker journal entries
      // (entity creation produces at least 1 journal entry per entity)
      expect(rows.length).toBeGreaterThanOrEqual(
        workerCount * entitiesPerWorker,
      );

      // All seq values must be strictly monotonic
      const seqs = rows.map((r) => r.seq);
      for (let i = 1; i < seqs.length; i++) {
        expect(
          seqs[i],
          `seq[${i}] (${seqs[i]}) should be > seq[${i - 1}] (${seqs[i - 1]})`,
        ).toBeGreaterThan(seqs[i - 1]);
      }

      // No duplicate seq values
      const uniqueSeqs = new Set(seqs);
      expect(uniqueSeqs.size).toBe(seqs.length);
    },
    { retry: 3, timeout: 30000 },
  );
});
