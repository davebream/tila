/**
 * Embedded tier: `tila-sdk/local` under plain Node, one `createTilaLocal`
 * instance per participant on a shared SQLite file in a temp directory. It
 * measures raw ops-sqlite cost with no HTTP. better-sqlite3 is synchronous, so
 * participants interleave rather than run in parallel; busy-retry contention
 * is semantic, not multi-process.
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { schema } from "@tila/ops-sqlite";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { buildLocalResources, createTilaLocal } from "tila-sdk/local";
import { HARNESS_VERSION } from "../result-schema";
import type { BenchFacade, Driver, Participant } from "../types";
import { sampleSqlite, sweepSqlite } from "./sqlite-sampling";

export interface EmbeddedDriverOptions {
  runId: string;
}

export function createEmbeddedDriver(opts: EmbeddedDriverOptions): Driver {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tila-bench-"));
  const dbPath = path.join(dir, "bench.db");
  const artifactsPath = path.join(dir, "artifacts");
  const closers: Array<() => void> = [];
  let sampler: {
    db: ReturnType<typeof drizzle>;
    sqlite: Database.Database;
  } | null = null;

  function openSampler() {
    if (!sampler) {
      const sqlite = new Database(dbPath);
      sampler = { db: drizzle(sqlite, { schema }), sqlite };
    }
    return sampler;
  }

  return {
    tier: "embedded",
    describe: () => ({
      deployed: false,
      notes: [
        "tila-sdk/local (EmbeddedProject over better-sqlite3) with one instance per participant on one DB file.",
        "Synchronous driver: participants interleave in one thread; no HTTP, no Worker.",
      ],
    }),
    async participants(n, principals) {
      const participants: Participant[] = [];
      for (let i = 0; i < n; i++) {
        const principalId =
          principals > 1 ? `local:bench-${i % principals}` : "local:bench";
        const participantId = `bench-${opts.runId}-p${i}`;
        const local = await createTilaLocal({
          dbPath,
          artifactsPath,
          project: "bench",
          skipFilesystemCheck: true,
          identity: {
            principal_id: principalId,
            participant_id: participantId,
            environment: {
              client_name: "tila-bench",
              client_version: HARNESS_VERSION,
            },
          },
        });
        closers.push(local.close);
        const resources = buildLocalResources(local.project, local.artifacts);
        const tila: BenchFacade = {
          tasks: resources.tasks,
          records: resources.records,
          claims: resources.claims,
          artifacts: resources.artifacts,
          signals: resources.signals,
          journal: resources.journal,
          presence: resources.presence,
          reentry: resources.reentry,
          summary: resources.summary,
          close: local.close,
        };
        participants.push({
          index: i,
          participantId,
          projectId: "bench",
          principalId,
          tila,
        });
      }
      return participants;
    },
    async sampleStore() {
      const s = openSampler();
      return sampleSqlite(s.db as never, s.sqlite);
    },
    async sweep() {
      const s = openSampler();
      return sweepSqlite(s.db as never);
    },
    async cleanup() {
      for (const close of closers) {
        try {
          close();
        } catch {
          // already closed
        }
      }
      sampler?.sqlite.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
