import { D1ProjectRegistry, D1SessionStore } from "@tila/backend-d1";
import { R2ArtifactBackend } from "@tila/backend-r2";
import {
  DRIFT_RECONCILE_THRESHOLD,
  SWEEP_BATCH_SIZE,
  SWEEP_MAX_DRAIN_ITERATIONS,
  SWEEP_TIME_BUDGET_MS,
} from "../config";
import type { Env } from "../types";
import { sweepExpiredKey } from "./sweep-key";

/** Outcome of a single per-project sweep sub-step. */
export type StepStatus = "ok" | "error" | "skipped";

/**
 * Per-project sweep outcome. One of these is emitted for every project the run
 * touches, whether it fully succeeded or was degraded by a failing sub-step.
 * Task 9 emits these as Analytics datapoints, so keep the shape flat and cheap.
 */
export interface ProjectSweepStatus {
  projectId: string;
  /** Overall rollup: "ok" only when every attempted sub-step succeeded. */
  status: "ok" | "degraded";
  /** Expired-artifact drain step. */
  sweep: StepStatus;
  /** Journal-archive step. */
  archive: StepStatus;
  /** Search-drift check (+ conditional reconcile) step. */
  drift: StepStatus;
  /** Expired artifacts successfully tombstoned+deleted this run. */
  expired: number;
  /**
   * Expired artifacts still pending after the drain loop stopped. >0 only when
   * the wall-clock budget or the drain-iteration clamp halted draining early.
   */
  remaining: number;
}

/**
 * Where a budget-truncated run stopped, so the next run (and operators) know
 * the backlog frontier. `null` when the run completed within budget.
 */
export interface SweepResumePoint {
  projectId: string;
  /** The phase at which the run ran out of budget for this project. */
  phase: "before-project" | "drain";
}

export interface SweepSummary {
  /** Projects that completed every attempted step with status "ok". */
  projectsSwept: number;
  /** Projects that were attempted but degraded by a failing sub-step. */
  projectsDegraded: number;
  artifactsExpired: number;
  r2DeleteErrors: number;
  driftChecksRun: number;
  driftReconciled: number;
  driftErrors: number;
  expiredSessions: number;
  journalEventsArchived: number;
  /** Per-project status objects (Task 9 emits these as Analytics). */
  projectStatuses: ProjectSweepStatus[];
  /** Resume frontier when the wall-clock budget truncated the run; else null. */
  resumePoint: SweepResumePoint | null;
}

interface JournalArchiveEvent {
  seq: number;
  t: number;
  kind: string;
  resource: string;
  actor: string;
  token_id: string | null;
  fence: number | null;
  data: Record<string, unknown>;
  source: string | null;
  source_version: string | null;
}

/** Minimal DO stub surface used by the sweep (eases testing). */
interface DoStub {
  fetch(req: Request | string, init?: RequestInit): Promise<Response>;
}

/**
 * Optional overrides for unit testing. The production caller invokes
 * `runSweep(env)` with no options: `projects` is then loaded from the D1
 * registry, `now` is `Date.now`, and the budget/batch come from config.
 */
export interface RunSweepOptions {
  /** Inject the project list instead of reading the D1 registry. */
  projects?: Array<{ projectId: string }>;
  /** Injectable monotonic clock (ms). Defaults to Date.now. */
  now?: () => number;
  /** Wall-clock budget in ms. Defaults to SWEEP_TIME_BUDGET_MS. */
  timeBudgetMs?: number;
  /** Expired-artifact page size per drain round. Defaults to SWEEP_BATCH_SIZE. */
  batchSize?: number;
}

export async function runSweep(
  env: Env,
  options: RunSweepOptions = {},
): Promise<SweepSummary> {
  console.log("[sweep] daily artifact cleanup started");
  const now = options.now ?? Date.now;
  const timeBudgetMs = options.timeBudgetMs ?? SWEEP_TIME_BUDGET_MS;
  const batchSize = options.batchSize ?? SWEEP_BATCH_SIZE;
  const deadline = now() + timeBudgetMs;

  const r2 = new R2ArtifactBackend(env.ARTIFACTS);
  const projects =
    options.projects ?? (await new D1ProjectRegistry(env.DB).listAll());

  const summary: SweepSummary = {
    projectsSwept: 0,
    projectsDegraded: 0,
    artifactsExpired: 0,
    r2DeleteErrors: 0,
    driftChecksRun: 0,
    driftReconciled: 0,
    driftErrors: 0,
    expiredSessions: 0,
    journalEventsArchived: 0,
    projectStatuses: [],
    resumePoint: null,
  };

  // Session expiry cleanup (global, not per-project).
  try {
    const sessionStore = new D1SessionStore(env.DB);
    const { deleted: expiredSessions } = await sessionStore.deleteExpired();
    console.log(`[sweep] deleted ${expiredSessions} expired sessions`);
    summary.expiredSessions = expiredSessions;
  } catch (err) {
    console.error("[sweep] session cleanup failed:", err);
  }

  for (const { projectId } of projects) {
    // Stop cleanly if the wall-clock budget is exhausted before this project.
    // The resume point captures the FRONTIER (the first project we did not
    // finish), so it is set once and never overwritten by a later iteration.
    if (now() >= deadline) {
      summary.resumePoint = { projectId, phase: "before-project" };
      console.warn(
        `[sweep] wall-clock budget exhausted; stopping before project ${projectId}`,
      );
      break;
    }

    const status = await sweepProject({
      projectId,
      env,
      r2,
      summary,
      now,
      deadline,
      batchSize,
    });

    summary.projectStatuses.push(status);
    if (status.status === "ok") {
      summary.projectsSwept++;
    } else {
      summary.projectsDegraded++;
    }

    // sweepProject sets a drain-phase resume point when it ran out of budget
    // mid-project. Stop here so the next iteration's before-project check does
    // not overwrite that frontier with a less-precise entry.
    if (summary.resumePoint !== null) {
      break;
    }
  }

  console.log("[sweep] completed:", JSON.stringify(summary));
  return summary;
}

/**
 * Sweep a single project. ALL per-project work is wrapped so that a throw in
 * any sub-step is captured as that project's degraded status — one project's
 * failure never aborts the run for its siblings.
 */
async function sweepProject(args: {
  projectId: string;
  env: Env;
  r2: R2ArtifactBackend;
  summary: SweepSummary;
  now: () => number;
  deadline: number;
  batchSize: number;
}): Promise<ProjectSweepStatus> {
  const { projectId, env, r2, summary, now, deadline, batchSize } = args;
  const status: ProjectSweepStatus = {
    projectId,
    status: "ok",
    sweep: "ok",
    archive: "skipped",
    drift: "skipped",
    expired: 0,
    remaining: 0,
  };

  const doId = env.PROJECT.idFromName(projectId);
  const doStub = env.PROJECT.get(doId) as unknown as DoStub;

  // --- 1. Expired-artifact drain loop ---
  let budgetHitDuringDrain = false;
  try {
    const drained = await drainExpiredArtifacts({
      projectId,
      doStub,
      r2,
      summary,
      now,
      deadline,
      batchSize,
    });
    status.expired = drained.expired;
    status.remaining = drained.remaining;
    budgetHitDuringDrain = drained.budgetHit;
    if (drained.budgetHit && summary.resumePoint === null) {
      summary.resumePoint = { projectId, phase: "drain" };
    }
  } catch (err) {
    console.error(
      `[sweep] expired-artifact sweep failed for ${projectId}:`,
      err,
    );
    status.sweep = "error";
  }

  // If the wall-clock budget was exhausted mid-drain, stop here: the project is
  // already a resume entry, and running archive/drift would only overrun the
  // budget. They stay "skipped" and the next run picks the project back up.
  if (budgetHitDuringDrain) {
    return status; // status stays "ok" rollup-wise; remaining>0 marks the work left
  }

  // --- 2. Journal archival ---
  status.archive = await archiveJournal({
    projectId,
    doStub,
    env,
    summary,
  });

  // --- 3. Search drift check + conditional reconciliation ---
  status.drift = await reconcileDrift({ projectId, doStub, summary });

  if (
    status.sweep === "error" ||
    status.archive === "error" ||
    status.drift === "error"
  ) {
    status.status = "degraded";
  }
  return status;
}

/**
 * Re-arm the DO /sweep call until the project returns fewer than `batchSize`
 * expired keys (fully drained) or the wall-clock budget / iteration clamp
 * stops it. Tombstoning each returned key removes it from the next round's
 * candidate set (DO listExpiredPointers filters tombstoned=0), so a strictly
 * shrinking batch is the termination signal — this is the core fix for the
 * monotonically-growing backlog.
 */
async function drainExpiredArtifacts(args: {
  projectId: string;
  doStub: DoStub;
  r2: R2ArtifactBackend;
  summary: SweepSummary;
  now: () => number;
  deadline: number;
  batchSize: number;
}): Promise<{ expired: number; remaining: number; budgetHit: boolean }> {
  const { projectId, doStub, r2, summary, now, deadline, batchSize } = args;
  let expiredThisProject = 0;

  for (let iteration = 0; iteration < SWEEP_MAX_DRAIN_ITERATIONS; iteration++) {
    if (now() >= deadline) {
      // Budget hit mid-drain: the project may still have expired pointers.
      // We cannot cheaply count the true remainder, so report ">=1 pending"
      // by returning remaining=1 as a non-zero "work left" sentinel and let
      // the resume point capture the frontier.
      return { expired: expiredThisProject, remaining: 1, budgetHit: true };
    }

    const res = await doStub.fetch("http://do/sweep", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ batch_size: batchSize }),
    });
    if (!res.ok) {
      throw new Error(`DO /sweep returned ${res.status}`);
    }
    const data = (await res.json()) as { expiredKeys?: string[] };
    const keys = data.expiredKeys ?? [];

    for (const key of keys) {
      const before = summary.artifactsExpired;
      await sweepExpiredKey(key, doStub, (k) => r2.delete(k), summary);
      if (summary.artifactsExpired > before) expiredThisProject++;
    }

    // Fewer than a full page => no more expired pointers remain. Done.
    if (keys.length < batchSize) {
      return { expired: expiredThisProject, remaining: 0, budgetHit: false };
    }
  }

  // Iteration clamp reached with full pages every round — treat the rest as
  // pending and surface a resume point. This should not happen in practice
  // (it implies tombstoning is not shrinking the candidate set).
  console.warn(
    `[sweep] project ${projectId} hit drain-iteration clamp (${SWEEP_MAX_DRAIN_ITERATIONS}); backlog may remain`,
  );
  return { expired: expiredThisProject, remaining: 1, budgetHit: true };
}

/**
 * Archive old journal events to R2. The R2 object key embeds the batch's
 * `throughSeq` so two runs that archive the SAME calendar month write DISTINCT
 * objects — archival across runs can never overwrite a prior month's audit log
 * (the original defect). throughSeq is monotonic and each batch covers a
 * disjoint seq range (see journal-archive-routes contract tests), so the
 * suffix is collision-free.
 *
 * Returns "ok" when archival completed (including the no-events no-op), "error"
 * when any step (request, R2 write, confirm) failed.
 */
async function archiveJournal(args: {
  projectId: string;
  doStub: DoStub;
  env: Env;
  summary: SweepSummary;
}): Promise<StepStatus> {
  const { projectId, doStub, env, summary } = args;
  try {
    const archiveRes = await doStub.fetch("http://do/journal/archive", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    if (!archiveRes.ok) {
      console.error(
        `[sweep] journal archive request failed for project ${projectId}: ${archiveRes.status}`,
      );
      return "error";
    }

    const archiveData = (await archiveRes.json()) as {
      ok: boolean;
      events?: JournalArchiveEvent[];
      throughSeq?: number;
      count?: number;
    };
    const count = archiveData.count ?? 0;
    if (
      count === 0 ||
      !archiveData.events ||
      archiveData.throughSeq === undefined
    ) {
      return "ok"; // Nothing to archive — clean no-op.
    }

    const throughSeq = archiveData.throughSeq;

    // Group events by UTC year/month for human-navigable R2 layout.
    const groups = new Map<string, JournalArchiveEvent[]>();
    for (const event of archiveData.events) {
      const d = new Date(event.t);
      const year = d.getUTCFullYear();
      const month = String(d.getUTCMonth() + 1).padStart(2, "0");
      const key = `${year}/${month}`;
      const group = groups.get(key);
      if (group) group.push(event);
      else groups.set(key, [event]);
    }

    for (const [yearMonth, groupEvents] of groups) {
      // The throughSeq suffix makes this key unique per archive batch, so a
      // later run archiving the same month writes a sibling object instead of
      // clobbering this one.
      const r2Key = `journal-archive/${projectId}/${yearMonth}.part-${throughSeq}.jsonl`;
      const jsonl = groupEvents.map((e) => JSON.stringify(e)).join("\n");
      // No try/catch here: a failed put must propagate so we do NOT confirm
      // (and therefore do NOT delete) the journal rows — preserving the audit
      // log. The throw is caught below and marks the project degraded.
      await env.ARTIFACTS.put(r2Key, jsonl);
    }

    // Confirm only after every group's R2 write succeeded.
    const confirmRes = await doStub.fetch("http://do/journal/archive/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ throughSeq }),
    });
    if (!confirmRes.ok) {
      console.error(
        `[sweep] journal confirm failed for project ${projectId}: ${confirmRes.status}`,
      );
      return "error";
    }

    console.log(
      `[sweep] project ${projectId} archived ${count} journal events`,
    );
    summary.journalEventsArchived += count;
    return "ok";
  } catch (archiveErr) {
    console.error(
      `[sweep] journal archival failed for project ${projectId}:`,
      archiveErr,
    );
    return "error";
  }
}

/**
 * Run the search-drift check and, when fail-findings exceed the threshold,
 * reconcile the search index. Returns "error" when the drift request or the
 * reconciliation throws (which marks the project degraded), "ok" otherwise.
 */
async function reconcileDrift(args: {
  projectId: string;
  doStub: DoStub;
  summary: SweepSummary;
}): Promise<StepStatus> {
  const { projectId, doStub, summary } = args;
  try {
    const driftRes = await doStub.fetch("http://do/artifact/search-drift");
    if (!driftRes.ok) {
      console.error(
        `[sweep] drift check returned ${driftRes.status} for project ${projectId}`,
      );
      return "error";
    }

    const drift = (await driftRes.json()) as {
      findings?: Array<{ check: string; count: number; status: string }>;
    };
    const findings = drift.findings ?? [];

    console.log(
      `[sweep] project ${projectId} drift metrics:`,
      JSON.stringify(
        findings.map((f) => ({
          check: f.check,
          count: f.count,
          status: f.status,
        })),
      ),
    );
    summary.driftChecksRun++;

    const totalFailCount = findings
      .filter((f) => f.status === "fail")
      .reduce((sum, f) => sum + f.count, 0);

    if (totalFailCount < DRIFT_RECONCILE_THRESHOLD) {
      return "ok";
    }

    console.log(
      `[sweep] project ${projectId} drift threshold exceeded (${totalFailCount} >= ${DRIFT_RECONCILE_THRESHOLD}), triggering reconciliation`,
    );
    try {
      const scanRes = await doStub.fetch(
        "http://do/artifact/search-rebuild-scan",
      );
      if (!scanRes.ok) {
        throw new Error(`search-rebuild-scan returned ${scanRes.status}`);
      }
      const scanData = (await scanRes.json()) as {
        ok: boolean;
        pointers: Array<unknown>;
      };

      const rebuildRes = await doStub.fetch(
        "http://do/artifact/search-rebuild",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            candidates: scanData.pointers,
            apply: true,
            actor: "sweep-cron",
          }),
        },
      );
      if (!rebuildRes.ok) {
        throw new Error(`search-rebuild returned ${rebuildRes.status}`);
      }
      console.log(
        `[sweep] project ${projectId} reconciliation completed successfully`,
      );
      summary.driftReconciled++;
      return "ok";
    } catch (reconcileErr) {
      console.error(
        `[sweep] project ${projectId} reconciliation failed:`,
        reconcileErr,
      );
      summary.driftErrors++;
      return "error";
    }
  } catch (driftErr) {
    console.error(`[sweep] project ${projectId} drift check failed:`, driftErr);
    summary.driftErrors++;
    return "error";
  }
}
