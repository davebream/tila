import { emitDoOperationDatapoint } from "./analytics";

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
  try {
    return await stub.fetch(new Request(url, init));
  } finally {
    if (analyticsCtx) {
      emitDoOperationDatapoint(analyticsCtx.analytics, analyticsCtx.ctx, {
        table: deriveTable(path),
        operationType: deriveOperationType(path),
        latencyMs: Date.now() - start,
        rowsAffected: 0,
        projectId: analyticsCtx.projectId,
      });
    }
  }
}
