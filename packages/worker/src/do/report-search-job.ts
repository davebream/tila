import { projectTransferOps, reportSearchOps } from "@tila/ops-sqlite";
import { createR2JournalArchiveReader } from "../r2";
import type { RouterDeps } from "./routes/types";

const KEY = "_report_search_job";
interface Job {
  projectId: string;
  failures: number;
  nextAt: number;
}

async function wake(deps: RouterDeps, at: number): Promise<void> {
  const current = await deps.ctx.storage.getAlarm();
  if (current === null || current > at) await deps.ctx.storage.setAlarm(at);
}

export async function scheduleReportIndex(
  deps: RouterDeps,
  projectId: string | undefined,
  restart = false,
): Promise<void> {
  // Export reads stay read-only. A later search resumes scheduling after unlock.
  if (!projectId || projectTransferOps.getTransferState(deps.ctx.storage.sql))
    return;
  const scope = reportSearchOps.startReportIndex(deps.db, restart);
  if (scope.status !== "running") return;
  const job = await deps.ctx.storage.get<Job>(KEY);
  if (!job || restart)
    await deps.ctx.storage.put<Job>(KEY, {
      projectId,
      failures: 0,
      nextAt: Date.now(),
    });
  await wake(deps, Date.now() + 100);
}

/** Shares the alarm with existing jobs without replacing their persisted state. */
export async function drainReportIndex(deps: RouterDeps): Promise<void> {
  const job = await deps.ctx.storage.get<Job>(KEY);
  if (!job) return;
  if (job.nextAt > Date.now()) {
    await wake(deps, job.nextAt);
    return;
  }
  const assertWritable = () => {
    const state = projectTransferOps.getTransferState(deps.ctx.storage.sql);
    if (state) throw new projectTransferOps.ProjectMaintenanceError(state);
  };
  try {
    assertWritable();
    const scope = await reportSearchOps.indexReportHistoryBatch(deps.db, {
      archives: deps.artifacts
        ? createR2JournalArchiveReader(deps.artifacts, job.projectId)
        : undefined,
      assertWritable,
    });
    assertWritable();
    if (scope.status === "complete" || scope.status === "pending") {
      await deps.ctx.storage.delete(KEY);
      return;
    }
    if (scope.status === "failed") {
      // Invalid/conflicting data needs repair. Retry unavailable storage at most five times.
      if (scope.error !== "journal-history-unavailable" || job.failures >= 5) {
        await deps.ctx.storage.delete(KEY);
        return;
      }
      job.failures++;
      reportSearchOps.startReportIndex(deps.db, true);
      job.nextAt = Date.now() + 1000 * 2 ** job.failures;
    } else {
      job.failures = 0;
      job.nextAt = Date.now() + 100;
    }
    await deps.ctx.storage.put(KEY, job);
    await wake(deps, job.nextAt);
  } catch (error) {
    if (!(error instanceof projectTransferOps.ProjectMaintenanceError))
      throw error;
    await wake(deps, Date.now() + 30_000);
  }
}
