import { D1ProjectRegistry, D1SessionStore } from "@tila/backend-d1";
import { R2ArtifactBackend } from "@tila/backend-r2";
import {
  DRIFT_RECONCILE_THRESHOLD,
  SWEEP_DRAIN_PAGE_SIZE,
  SWEEP_MAX_DRAIN_ITERATIONS,
  SWEEP_SUBREQUESTS_PER_KEY,
  SWEEP_SUBREQUEST_BUDGET,
  SWEEP_TIME_BUDGET_MS,
} from "../config";
import type { Env } from "../types";
import { sweepExpiredKey } from "./sweep-key";

/**
 * Tracks subrequests issued across the whole invocation. Cloudflare caps
 * subrequests at 1000 PER INVOCATION; a cron sweep is one invocation fanning
 * out over every project and every drain round, so this counter is shared and
 * accumulates globally — never reset per project or per round.
 */
interface SweepBudget {
  /** Subrequests issued so far this invocation. */
  subrequests: number;
  /** Ceiling; the run stops cleanly before crossing it. */
  ceiling: number;
}

/** True when issuing `n` more subrequests would cross the ceiling. */
function wouldExceed(budget: SweepBudget, n: number): boolean {
  return budget.subrequests + n > budget.ceiling;
}

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
   * Expired-artifact backlog signal for this project, NOT an exact count:
   *   0   — the project was fully drained (no expired pointers remain), or
   *   ≥1  — the drain stopped early (budget or clamp) and ≥1 pointer is pending.
   * Counting the true remainder would cost an extra DO round-trip, which defeats
   * the subrequest budget, so this is a 0/≥1 sentinel. Pair with `truncated`.
   */
  remaining: number;
  /**
   * True when the drain stopped before clearing this project — either the
   * shared subrequest/wall-clock budget was exhausted, or the per-project
   * iteration clamp was hit. Analytics should treat `remaining` as a boolean
   * "work left" signal via this field, not as a magnitude.
   */
  truncated: boolean;
}

/**
 * Where a budget-truncated run stopped, so the next run (and operators) know
 * the backlog frontier. `null` when the run completed within budget. Only a
 * true RUN-level budget exhaustion (subrequest or wall-clock) sets this — a
 * per-project iteration clamp does not, since the run continues to siblings.
 */
export interface SweepResumePoint {
  projectId: string;
  /** The phase / cause at which the run ran out of budget. */
  phase: "before-project" | "drain" | "subrequest-budget";
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
 * registry, `now` is `Date.now`, and the budgets/page come from config.
 */
export interface RunSweepOptions {
  /** Inject the project list instead of reading the D1 registry. */
  projects?: Array<{ projectId: string }>;
  /** Injectable monotonic clock (ms). Defaults to Date.now. */
  now?: () => number;
  /** Wall-clock budget in ms. Defaults to SWEEP_TIME_BUDGET_MS. */
  timeBudgetMs?: number;
  /** Expired-artifact page size per drain round. Defaults to SWEEP_DRAIN_PAGE_SIZE. */
  drainPageSize?: number;
  /** Per-invocation subrequest ceiling. Defaults to SWEEP_SUBREQUEST_BUDGET. */
  subrequestBudget?: number;
}

export async function runSweep(
  env: Env,
  options: RunSweepOptions = {},
): Promise<SweepSummary> {
  console.log("[sweep] daily artifact cleanup started");
  const now = options.now ?? Date.now;
  const timeBudgetMs = options.timeBudgetMs ?? SWEEP_TIME_BUDGET_MS;
  const drainPageSize = options.drainPageSize ?? SWEEP_DRAIN_PAGE_SIZE;
  const deadline = now() + timeBudgetMs;
  // Shared across ALL projects and ALL drain rounds — a cron sweep is a single
  // Worker invocation and the subrequest cap is per-invocation.
  const budget: SweepBudget = {
    subrequests: 0,
    ceiling: options.subrequestBudget ?? SWEEP_SUBREQUEST_BUDGET,
  };

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

  // Session expiry cleanup (global, not per-project). One D1 subrequest.
  try {
    const sessionStore = new D1SessionStore(env.DB);
    const { deleted: expiredSessions } = await sessionStore.deleteExpired();
    budget.subrequests++;
    console.log(`[sweep] deleted ${expiredSessions} expired sessions`);
    summary.expiredSessions = expiredSessions;
  } catch (err) {
    console.error("[sweep] session cleanup failed:", err);
  }

  for (const { projectId } of projects) {
    // Stop cleanly if a RUN-level budget is exhausted before this project. The
    // resume point captures the FRONTIER (the first project we did not finish),
    // so it is set once and never overwritten by a later iteration.
    if (now() >= deadline) {
      summary.resumePoint = { projectId, phase: "before-project" };
      console.warn(
        `[sweep] wall-clock budget exhausted; stopping before project ${projectId}`,
      );
      break;
    }
    // A project needs at least one /sweep round (1 subrequest) to do anything;
    // if even that would cross the subrequest ceiling, stop and resume later.
    if (wouldExceed(budget, 1)) {
      summary.resumePoint = { projectId, phase: "subrequest-budget" };
      console.warn(
        `[sweep] subrequest budget exhausted (${budget.subrequests}/${budget.ceiling}); stopping before project ${projectId}`,
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
      drainPageSize,
      budget,
    });

    summary.projectStatuses.push(status);
    if (status.status === "ok") {
      summary.projectsSwept++;
    } else {
      summary.projectsDegraded++;
    }

    // sweepProject sets a drain/subrequest-budget resume point when it ran out
    // of a RUN-level budget mid-project. Stop here so the next iteration's
    // before-project check does not overwrite that frontier. A per-project
    // iteration-clamp does NOT set resumePoint, so the loop continues past it.
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
  drainPageSize: number;
  budget: SweepBudget;
}): Promise<ProjectSweepStatus> {
  const { projectId, env, r2, summary, now, deadline, drainPageSize, budget } =
    args;
  const status: ProjectSweepStatus = {
    projectId,
    status: "ok",
    sweep: "ok",
    archive: "skipped",
    drift: "skipped",
    expired: 0,
    remaining: 0,
    truncated: false,
  };

  const doId = env.PROJECT.idFromName(projectId);
  const doStub = env.PROJECT.get(doId) as unknown as DoStub;

  // --- 1. Expired-artifact drain loop ---
  let runBudgetHit = false;
  try {
    const drained = await drainExpiredArtifacts({
      projectId,
      doStub,
      r2,
      summary,
      now,
      deadline,
      drainPageSize,
      budget,
    });
    status.expired = drained.expired;
    status.remaining = drained.remaining;
    status.truncated = drained.budgetHit || drained.clampHit;
    runBudgetHit = drained.budgetHit;

    // A RUN-level budget exhaustion sets the resume frontier and stops the run.
    if (drained.budgetHit && summary.resumePoint === null) {
      summary.resumePoint = {
        projectId,
        phase: drained.budgetPhase ?? "drain",
      };
    }
    // The per-project iteration clamp marks ONLY this project degraded; it does
    // NOT set a resume point, so sibling projects still run.
    if (drained.clampHit) {
      status.sweep = "error";
    }
  } catch (err) {
    console.error(
      `[sweep] expired-artifact sweep failed for ${projectId}:`,
      err,
    );
    status.sweep = "error";
  }

  // If a RUN-level budget was exhausted mid-drain, stop here: the project is
  // already the resume frontier, and running archive/drift would only push us
  // further past the budget. They stay "skipped" and the next run resumes.
  if (runBudgetHit) {
    return status; // remaining≥1 + truncated mark the work left for next run
  }

  // --- 2. Journal archival --- (skip if the subrequest budget is spent)
  if (!wouldExceed(budget, 1)) {
    status.archive = await archiveJournal({
      projectId,
      doStub,
      env,
      summary,
      budget,
    });
  }

  // --- 3. Search drift check + conditional reconciliation ---
  if (!wouldExceed(budget, 1)) {
    status.drift = await reconcileDrift({ projectId, doStub, summary, budget });
  }

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
interface DrainResult {
  expired: number;
  /** 0/≥1 backlog sentinel (see ProjectSweepStatus.remaining). */
  remaining: number;
  /** A RUN-level budget (wall-clock or subrequest) was exhausted mid-drain. */
  budgetHit: boolean;
  /** Which RUN-level budget tripped (only meaningful when budgetHit). */
  budgetPhase?: "drain" | "subrequest-budget";
  /** The per-project iteration clamp was hit (NOT run-aborting). */
  clampHit: boolean;
}

async function drainExpiredArtifacts(args: {
  projectId: string;
  doStub: DoStub;
  r2: R2ArtifactBackend;
  summary: SweepSummary;
  now: () => number;
  deadline: number;
  drainPageSize: number;
  budget: SweepBudget;
}): Promise<DrainResult> {
  const {
    projectId,
    doStub,
    r2,
    summary,
    now,
    deadline,
    drainPageSize,
    budget,
  } = args;
  let expiredThisProject = 0;

  for (let iteration = 0; iteration < SWEEP_MAX_DRAIN_ITERATIONS; iteration++) {
    // Wall-clock budget: stop the whole run, the project keeps its backlog.
    if (now() >= deadline) {
      return {
        expired: expiredThisProject,
        remaining: 1,
        budgetHit: true,
        budgetPhase: "drain",
        clampHit: false,
      };
    }
    // Subrequest budget: even one more /sweep round would cross the ceiling.
    if (wouldExceed(budget, 1)) {
      return {
        expired: expiredThisProject,
        remaining: 1,
        budgetHit: true,
        budgetPhase: "subrequest-budget",
        clampHit: false,
      };
    }

    const res = await doStub.fetch("http://do/sweep", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ batch_size: drainPageSize }),
    });
    budget.subrequests++;
    if (!res.ok) {
      throw new Error(`DO /sweep returned ${res.status}`);
    }
    const data = (await res.json()) as { expiredKeys?: string[] };
    const keys = data.expiredKeys ?? [];

    for (const key of keys) {
      // Each key costs SWEEP_SUBREQUESTS_PER_KEY subrequests. If processing it
      // would cross the ceiling, stop mid-page: the unprocessed keys (and any
      // not yet returned) remain expired and are picked up by the next run.
      if (wouldExceed(budget, SWEEP_SUBREQUESTS_PER_KEY)) {
        return {
          expired: expiredThisProject,
          remaining: 1,
          budgetHit: true,
          budgetPhase: "subrequest-budget",
          clampHit: false,
        };
      }
      const before = summary.artifactsExpired;
      await sweepExpiredKey(key, doStub, (k) => r2.delete(k), summary);
      budget.subrequests += SWEEP_SUBREQUESTS_PER_KEY;
      if (summary.artifactsExpired > before) expiredThisProject++;
    }

    // Fewer than a full page => no more expired pointers remain. Done.
    if (keys.length < drainPageSize) {
      return {
        expired: expiredThisProject,
        remaining: 0,
        budgetHit: false,
        clampHit: false,
      };
    }
  }

  // Iteration clamp reached with full pages every round. This should not happen
  // in practice (it implies tombstoning is not shrinking the candidate set), so
  // mark ONLY this project degraded and let the run continue to siblings — do
  // NOT treat it as a run-aborting budget hit.
  console.warn(
    `[sweep] project ${projectId} hit drain-iteration clamp (${SWEEP_MAX_DRAIN_ITERATIONS}); marking degraded, continuing run`,
  );
  return {
    expired: expiredThisProject,
    remaining: 1,
    budgetHit: false,
    clampHit: true,
  };
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
  budget: SweepBudget;
}): Promise<StepStatus> {
  const { projectId, doStub, env, summary, budget } = args;
  try {
    const archiveRes = await doStub.fetch("http://do/journal/archive", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    budget.subrequests++;
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
      budget.subrequests++;
    }

    // Confirm only after every group's R2 write succeeded.
    const confirmRes = await doStub.fetch("http://do/journal/archive/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ throughSeq }),
    });
    budget.subrequests++;
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
  budget: SweepBudget;
}): Promise<StepStatus> {
  const { projectId, doStub, summary, budget } = args;
  try {
    const driftRes = await doStub.fetch("http://do/artifact/search-drift");
    budget.subrequests++;
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
      budget.subrequests++;
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
      budget.subrequests++;
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
