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
  },
): void {
  try {
    ctx.waitUntil(
      Promise.resolve(
        analytics.writeDataPoint({
          blobs: [fields.route, fields.method, fields.projectId, "request"],
          doubles: [fields.latencyMs, fields.statusCode],
          indexes: [fields.projectId || "anonymous"],
        }),
      ),
    );
  } catch {
    // Swallow -- emission is never load-bearing
  }
}

/**
 * Audit datapoint for the infra-owner destroy endpoint. Because that endpoint is
 * authenticated by a SHARED secret (no per-actor identity), this is the only
 * forensic footprint in the Worker layer — so it is emitted on every
 * authenticated attempt, including rejections. `executionCtx` is optional: when
 * absent (e.g. unit tests) the write runs inline instead of via waitUntil.
 */
export function emitInfraDestroyDatapoint(
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
        blobs: [fields.projectId, fields.outcome, "infra_destroy"],
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
