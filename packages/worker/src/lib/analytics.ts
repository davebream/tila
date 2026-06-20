/**
 * Central analytics helper -- all writeDataPoint calls go through this module.
 * Emission is fire-and-forget: try/catch guards ensure failures never propagate.
 * See contracts.md section 3 and decisions.md section 14.
 */

import type { Context } from "hono";
import type { Env, HonoVariables } from "../types";

type AppContext = Context<{ Bindings: Env; Variables: HonoVariables }>;

/** Extract analyticsCtx from a Hono context for passing to forwardToDO */
export function analyticsCtxFrom(c: AppContext) {
  return {
    analytics: c.env.ANALYTICS,
    ctx: c.executionCtx,
    projectId: c.get("projectId") ?? "",
    requestId: c.get("requestId"),
  };
}

export function emitRequestDatapoint(
  analytics: AnalyticsEngineDataset,
  ctx: ExecutionContext,
  fields: {
    route: string;
    method: string;
    projectId: string;
    latencyMs: number;
    statusCode: number;
    errorCode?: string;
    retryable?: boolean;
  },
): void {
  try {
    ctx.waitUntil(
      Promise.resolve(
        analytics.writeDataPoint({
          blobs: [
            fields.route,
            fields.method,
            fields.projectId,
            "request",
            fields.errorCode ?? "",
          ],
          doubles: [
            fields.latencyMs,
            fields.statusCode,
            fields.retryable ? 1 : 0,
          ],
          indexes: [fields.projectId || "anonymous"],
        }),
      ),
    );
  } catch {
    // Swallow -- emission is never load-bearing
  }
}

/**
 * Distinct datapoint for Worker-level unhandled errors (500 branch in
 * middleware/error.ts). Fire-and-forget — never throws. Carries route and
 * errorName so an operator can distinguish RangeError vs TypeError vs
 * domain-level unhandled throws without PII in Analytics.
 */
export function emitUnhandledErrorDatapoint(
  analytics: AnalyticsEngineDataset,
  ctx: ExecutionContext,
  fields: { route: string; errorName: string },
): void {
  try {
    ctx.waitUntil(
      Promise.resolve(
        analytics.writeDataPoint({
          blobs: [fields.route, fields.errorName, "unhandled_error"],
          doubles: [1],
          indexes: ["unhandled"],
        }),
      ),
    );
  } catch {
    // Swallow -- emission is never load-bearing
  }
}

/**
 * Audit datapoint for the infra-owner admin endpoints. Because those endpoints are
 * authenticated by a SHARED secret (no per-actor identity), this is the only
 * forensic footprint in the Worker layer — so it is emitted on every
 * authenticated attempt, including rejections. `executionCtx` is optional: when
 * absent (e.g. unit tests) the write runs inline instead of via waitUntil.
 */
export function emitInfraAdminDatapoint(
  analytics: AnalyticsEngineDataset | undefined,
  ctx: ExecutionContext | undefined,
  fields: {
    projectId: string;
    outcome: string;
    statusCode: number;
  },
): void {
  if (!analytics) return;
  try {
    const write = () =>
      analytics.writeDataPoint({
        blobs: [fields.projectId, fields.outcome, "infra_admin"],
        doubles: [fields.statusCode],
        indexes: [fields.projectId || "unknown"],
      });
    if (ctx) {
      ctx.waitUntil(Promise.resolve(write()));
    } else {
      write();
    }
  } catch {
    // Swallow -- emission is never load-bearing
  }
}

/**
 * Per-project sweep datapoint (Task 9 / PR17 observability). One is emitted for
 * every project the nightly sweep touches, carrying the rollup status and the
 * sub-step outcomes + counts. Structural metadata only — NEVER a secret/token.
 *
 * `executionCtx` is optional: the cron sweep runs `runSweep(env)` outside a Hono
 * request (no ExecutionContext), so when absent the write runs inline rather
 * than via waitUntil. Emission is best-effort and never load-bearing — a
 * missing dataset (e.g. the seam unit tests pass ANALYTICS = undefined) or a
 * throw is swallowed.
 */
export function emitSweepProjectDatapoint(
  analytics: AnalyticsEngineDataset | undefined,
  ctx: ExecutionContext | undefined,
  fields: {
    projectId: string;
    status: string;
    sweep: string;
    archive: string;
    drift: string;
    expired: number;
    remaining: number;
    truncated: boolean;
  },
): void {
  if (!analytics) return;
  try {
    const write = () =>
      analytics.writeDataPoint({
        blobs: [
          fields.projectId,
          fields.status,
          fields.sweep,
          fields.archive,
          fields.drift,
          "sweep_project",
        ],
        doubles: [fields.expired, fields.remaining, fields.truncated ? 1 : 0],
        indexes: [fields.projectId || "unknown"],
      });
    if (ctx) {
      ctx.waitUntil(Promise.resolve(write()));
    } else {
      write();
    }
  } catch {
    // Swallow -- emission is never load-bearing
  }
}

/**
 * Sweep-level error datapoint (Task 9 / PR17). Emitted when the nightly sweep
 * throws BEFORE (or outside) the per-project loop — the failure mode that
 * previously aborted the whole run silently. This is the only forensic
 * footprint for a pre-loop crash, so it is emitted unconditionally on catch.
 * Structural metadata only — NEVER a secret/token. `executionCtx` optional (see
 * emitSweepProjectDatapoint).
 */
export function emitSweepErrorDatapoint(
  analytics: AnalyticsEngineDataset | undefined,
  ctx: ExecutionContext | undefined,
  fields: { phase: string },
): void {
  if (!analytics) return;
  try {
    const write = () =>
      analytics.writeDataPoint({
        blobs: [fields.phase, "sweep_error"],
        doubles: [1],
        indexes: ["sweep"],
      });
    if (ctx) {
      ctx.waitUntil(Promise.resolve(write()));
    } else {
      write();
    }
  } catch {
    // Swallow -- emission is never load-bearing
  }
}

/**
 * Run-level ROLLUP sweep datapoint (Task 9 / PR17). Exactly one is emitted per
 * sweep run, carrying aggregate totals from the SweepSummary. Because per-project
 * datapoints are capped to stay under the Analytics Engine 250/invocation limit
 * (see SWEEP_ANALYTICS_MAX_PROJECT_DATAPOINTS), this rollup guarantees that
 * aggregate observability survives at ANY fleet size — even when the per-project
 * stream is truncated. Indexed under the stable "sweep" key (AE allows 1 index
 * per datapoint). Structural totals only — NEVER a secret/token or a project id.
 * `executionCtx` optional (see emitSweepProjectDatapoint).
 */
export function emitSweepRollupDatapoint(
  analytics: AnalyticsEngineDataset | undefined,
  ctx: ExecutionContext | undefined,
  fields: {
    projectsSwept: number;
    projectsDegraded: number;
    artifactsExpired: number;
    journalEventsArchived: number;
    driftReconciled: number;
    projectsEmitted: number;
    truncated: boolean;
  },
): void {
  if (!analytics) return;
  try {
    const write = () =>
      analytics.writeDataPoint({
        blobs: [fields.truncated ? "truncated" : "complete", "sweep_rollup"],
        doubles: [
          fields.projectsSwept,
          fields.projectsDegraded,
          fields.artifactsExpired,
          fields.journalEventsArchived,
          fields.driftReconciled,
          fields.projectsEmitted,
        ],
        indexes: ["sweep"],
      });
    if (ctx) {
      ctx.waitUntil(Promise.resolve(write()));
    } else {
      write();
    }
  } catch {
    // Swallow -- emission is never load-bearing
  }
}

/**
 * Outcome values for admin roster operations (grant or revoke).
 * Enumerated here so Tasks 5/6/7 (route handlers) stay consistent.
 */
export type AdminRosterOutcome =
  | "success"
  | "denied"
  | "last-admin"
  | "login-unresolved"
  | "github-user-not-found"
  | "github-error";

/**
 * Audit datapoint for admin roster grant/revoke operations. Emitted on both
 * success and in-handler denials (409 last-admin, 422 login-unresolved, 404,
 * 502) to leave a forensic footprint. 403s from requireProjectAdmin cannot be
 * intercepted here (middleware short-circuits before the handler runs).
 *
 * Best-effort: swallows all errors and never throws into the request path.
 * `ctx` is optional: when absent the write runs inline (matching the pattern
 * used by emitInfraAdminDatapoint and sweep emitters).
 *
 * Blobs: [projectId, action, outcome, "admin_roster"]
 * Doubles: [statusCode]
 * Indexes: [projectId || "unknown"]
 */
export function emitAdminRosterDatapoint(
  analytics: AnalyticsEngineDataset | undefined,
  ctx: ExecutionContext | undefined,
  fields: {
    projectId: string;
    action: "grant" | "revoke";
    outcome: AdminRosterOutcome;
    statusCode: number;
  },
): void {
  if (!analytics) return;
  try {
    const write = () =>
      analytics.writeDataPoint({
        blobs: [
          fields.projectId,
          fields.action,
          fields.outcome,
          "admin_roster",
        ],
        doubles: [fields.statusCode],
        indexes: [fields.projectId || "unknown"],
      });
    if (ctx) {
      ctx.waitUntil(Promise.resolve(write()));
    } else {
      write();
    }
  } catch {
    // Swallow -- emission is never load-bearing
  }
}

export function emitDoOperationDatapoint(
  analytics: AnalyticsEngineDataset,
  ctx: ExecutionContext,
  fields: {
    table: string;
    operationType: string;
    latencyMs: number;
    rowsAffected: number;
    projectId: string;
  },
): void {
  try {
    ctx.waitUntil(
      Promise.resolve(
        analytics.writeDataPoint({
          blobs: [
            fields.table,
            fields.operationType,
            fields.projectId,
            "do_operation",
          ],
          doubles: [fields.latencyMs, fields.rowsAffected],
          indexes: [fields.projectId || "anonymous"],
        }),
      ),
    );
  } catch {
    // Swallow -- emission is never load-bearing
  }
}
