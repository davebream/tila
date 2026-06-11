import { DurableObject } from "cloudflare:workers";
import { parseSchemaToml } from "@tila/core";
import type { EnrichOpts } from "@tila/ops-sqlite";
import { schema, searchReindexOps } from "@tila/ops-sqlite";
import { drizzle } from "drizzle-orm/durable-sqlite";
import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";
import { runMigrationsWithPitrRollback } from "./migration-runner";
import { createProjectRouter } from "./project-do-router";

/** KV key for the reindex job state stored in DO storage */
const REINDEX_KV_KEY = "_reindex_state";

/** Delay between alarm-driven batches (ms) */
const REINDEX_ALARM_DELAY_MS = 100;
const REINDEX_DEADLINE_MS = 5 * 60_000;
const MAX_REINDEX_ATTEMPTS = 50;
const REINDEX_FAILED_KV_KEY = "_reindex_failed";

export type ReindexState = {
  kind: "artifact" | "entity";
  batchSize: number;
  processed: number;
  startedAt: number;
  attempts: number;
};

export class ProjectDO extends DurableObject {
  private db: DrizzleSqliteDODatabase<typeof schema>;
  private router: ReturnType<typeof createProjectRouter>;

  constructor(ctx: DurableObjectState, env: Record<string, unknown>) {
    super(ctx, env);
    this.db = drizzle(ctx.storage, { schema });

    ctx.blockConcurrencyWhile(async () => {
      await runMigrationsWithPitrRollback(ctx.storage, () => ctx.abort());
    });

    this.router = createProjectRouter({
      ctx,
      db: this.db,
      enrichOpts: () => this.enrichOpts(),
    });
  }

  /**
   * Returns enrichment options for entity reads.
   * T1 has landed: uses parseSchemaToml from @tila/core for legacy-default enrichment.
   */
  private enrichOpts(): EnrichOpts {
    return {
      db: this.db,
      parseSchemaToml,
    };
  }

  async fetch(request: Request): Promise<Response> {
    return this.router.fetch(request);
  }

  /**
   * Alarm handler for batched FTS reindex.
   *
   * Reads reindex state from DO KV storage (_reindex_state).
   * Processes one batch via reindexBatch, then either schedules the next alarm
   * (if more work remains) or clears the state (if done).
   */
  async alarm(): Promise<void> {
    const state = await this.ctx.storage.get<ReindexState>(REINDEX_KV_KEY);
    if (!state) {
      // No pending reindex -- no-op
      return;
    }

    const result = searchReindexOps.reindexBatch(this.db, {
      kind: state.kind,
      batchSize: state.batchSize,
    });

    const totalProcessed = state.processed + result.processed;
    const nextAttempts = state.attempts + 1;
    const deadlineExceeded = Date.now() - state.startedAt > REINDEX_DEADLINE_MS;
    const attemptsExceeded = nextAttempts > MAX_REINDEX_ATTEMPTS;

    if (result.done) {
      // All rows indexed -- clean up KV state
      await this.ctx.storage.delete(REINDEX_KV_KEY);
      await this.ctx.storage.delete(REINDEX_FAILED_KV_KEY);
    } else if (deadlineExceeded || attemptsExceeded) {
      const reason = attemptsExceeded
        ? "attempt-cap-exceeded"
        : "deadline-exceeded";
      await this.ctx.storage.delete(REINDEX_KV_KEY);
      await this.ctx.storage.put(REINDEX_FAILED_KV_KEY, {
        kind: state.kind,
        processed: totalProcessed,
        attempts: nextAttempts,
        startedAt: state.startedAt,
        failedAt: Date.now(),
        reason,
      });
    } else {
      // Update cumulative processed count and schedule next batch
      await this.ctx.storage.put<ReindexState>(REINDEX_KV_KEY, {
        ...state,
        processed: totalProcessed,
        attempts: nextAttempts,
      });
      // Reserve the DO's single alarm slot for the active reindex loop.
      await this.ctx.storage.setAlarm(Date.now() + REINDEX_ALARM_DELAY_MS);
    }
  }
}
