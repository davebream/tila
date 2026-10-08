import type { Context, ExecutionContext } from "hono";
import type { Env, HonoVariables } from "../types";
import { emitDoOperationDatapoint } from "./analytics";
import type { RequestTiming } from "./server-timing";

/**
 * Build the extra headers that forward the caller-scoped idempotency key + body
 * hash to the DO, so the DO can dedup a fence-mutating write inside its own
 * transaction (audit B1). Returns undefined when the request carried no
 * Idempotency-Key (the middleware then left these unset), so forwarding is a
 * no-op and DO behavior is unchanged.
 */
export function idempotencyHeaders(
  c: Context<{ Bindings: Env; Variables: HonoVariables }>,
): Record<string, string> | undefined {
  const key = c.get("idempotencyKey");
  if (!key) return undefined;
  return {
    "Idempotency-Key": key,
    "X-Idempotency-Hash": c.get("idempotencyHash") ?? "",
  };
}

/** Map of first DO path segment to canonical table name */
const TABLE_MAP: Record<string, string> = {
  entity: "entities",
  claim: "claims",
  coord: "claims", // coordination routes (acquire, renew, heartbeat, claims, presence)
  artifact: "artifact_pointers",
  journal: "journal",
  presence: "presence",
  schema: "schema_history",
  sweep: "_sweep",
  gate: "gates",
  record: "records",
  signal: "signals",
};

function deriveTable(path: string): string {
  const segments = path.split("/").filter(Boolean);
  return TABLE_MAP[segments[0]] ?? segments[0];
}

function deriveOperationType(path: string): string {
  const segments = path.split("/").filter(Boolean);
  // Use segments[1] (the verb) to avoid high-cardinality UUIDs in paths like /entity/get/<id>
  return segments.length > 1 ? segments[1] : segments[0];
}

export async function forwardToDO(
  stub: DurableObjectStub,
  path: string,
  method: string,
  body?: unknown,
  query?: Record<string, string>,
  analyticsCtx?: {
    analytics: AnalyticsEngineDataset;
    ctx: ExecutionContext;
    projectId: string;
    requestId?: string;
    timing?: RequestTiming;
  },
  extraHeaders?: Record<string, string>,
): Promise<Response> {
  const url = new URL(`https://do${path}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
  }
  const headers: Record<string, string> = { ...extraHeaders };
  if (analyticsCtx?.requestId) {
    headers["X-Request-ID"] = analyticsCtx.requestId;
  }
  const init: RequestInit = { method };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  if (Object.keys(headers).length > 0) {
    init.headers = headers;
  }

  const start = analyticsCtx ? Date.now() : 0;
  let res: Response | undefined;
  try {
    const fetch = () => stub.fetch(new Request(url, init));
    res = analyticsCtx?.timing
      ? await analyticsCtx.timing.measure(
          path === "/admin/transfer/status" ? "transfer" : "do",
          fetch,
        )
      : await fetch();
    return res;
  } catch (error) {
    // ctx.abort() resets the DO before its response can cross the RPC boundary.
    // Its reason reaches the Worker as a remote exception, so acknowledge only
    // this deliberate restart. Never retry it or hide other transport failures.
    if (
      path === "/admin/restart" &&
      method === "POST" &&
      error instanceof Error &&
      "remote" in error &&
      error.remote === true &&
      error.message === "admin restart requested"
    ) {
      res = Response.json({ ok: true });
      return res;
    }
    throw error;
  } finally {
    if (analyticsCtx) {
      emitDoOperationDatapoint(analyticsCtx.analytics, analyticsCtx.ctx, {
        table: deriveTable(path),
        operationType: deriveOperationType(path),
        latencyMs: Date.now() - start,
        rowsAffected: parseRows(res?.headers.get("X-Rows-Affected")),
        projectId: analyticsCtx.projectId,
      });
    }
  }
}

/**
 * Parse the `X-Rows-Affected` header value to an integer.
 * Returns 0 on absent or non-numeric values (read paths / errors).
 */
function parseRows(raw: string | null | undefined): number {
  if (!raw) return 0;
  const n = Number.parseInt(raw, 10);
  return Number.isNaN(n) ? 0 : n;
}
