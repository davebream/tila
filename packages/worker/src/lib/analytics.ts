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
