import {
  type Settled,
  assembleRuntimeView,
  runtimeAttention,
} from "@tila/core";
import {
  AgentRuntimePageSchema,
  RUNTIME_ATTENTION_SCAN_LIMIT,
  RUNTIME_VIEW_MAX_LIMIT,
  type RuntimeViewQuery,
  type RuntimeViewResponse,
  RuntimeViewResponseSchema,
} from "@tila/schemas";
import type { Context } from "hono";
import { RuntimeStore } from "../d1";
import { compatibilityPolicy, scopedPolicy } from "../middleware/capability";
import type { Env, HonoVariables } from "../types";
import { agentAuthorityFor, agentAuthorityHeaders } from "./agent-authority";
import { forwardToDO } from "./do-forward";
import { runtimeVisibilityScope } from "./runtime-access";

type RuntimeViewContext = Context<{ Bindings: Env; Variables: HonoVariables }>;

/** D1 lookups that exceed this are reported as unavailable, not awaited. */
const SOURCE_TIMEOUT_MS = 2_000;

export class RuntimeViewCursorError extends Error {}

export function encodeRuntimeCursor(after: string) {
  return btoa(JSON.stringify({ after }))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

export function decodeRuntimeCursor(cursor: string) {
  try {
    const json = atob(cursor.replaceAll("-", "+").replaceAll("_", "/"));
    const value = JSON.parse(json) as { after?: unknown };
    if (typeof value.after === "string" && value.after) return value.after;
  } catch {
    // Fall through to the typed error.
  }
  throw new RuntimeViewCursorError("Invalid cursor");
}

async function settle<T>(work: () => Promise<T>): Promise<Settled<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const value = await Promise.race([
      work(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("source timeout")),
          SOURCE_TIMEOUT_MS,
        );
      }),
    ]);
    return { status: "ok", value };
  } catch {
    return { status: "unavailable" };
  } finally {
    clearTimeout(timer);
  }
}

type RuntimeStoreReader = Pick<RuntimeStore, "runsByIds" | "enrollmentsByIds">;
type RuntimeViewBody = Omit<RuntimeViewResponse, "next_cursor">;

/**
 * One DO agent page joined with D1 runs and enrollments. A DO failure is
 * returned as-is so the client never mistakes it for "no agents"; a D1 failure
 * degrades to per-source `unavailable` with `unknown` occupancy.
 */
async function loadPage(
  c: RuntimeViewContext,
  params: URLSearchParams,
  store: RuntimeStoreReader,
): Promise<Response | { body: RuntimeViewBody; next_after: string | null }> {
  const response = await forwardToDO(
    c.get("doStub"),
    `/agents/internal/runtime-page?${params}`,
    "GET",
    undefined,
    undefined,
    undefined,
    agentAuthorityHeaders(agentAuthorityFor(c)),
  );
  if (!response.ok) return response;
  const page = AgentRuntimePageSchema.parse(await response.json());
  const serverNow = Date.now();

  const bindings = page.rows.flatMap((row) =>
    [row.current, row.previous].flatMap((occupant) =>
      occupant ? [occupant.binding] : [],
    ),
  );
  const runIds = bindings.map((binding) => binding.holder.run_id);
  const enrollmentIds = bindings.flatMap((binding) =>
    binding.holder.enrollment_id ? [binding.holder.enrollment_id] : [],
  );
  const project = c.get("projectId");
  const [runs, enrollments] = await Promise.all([
    settle(() => store.runsByIds(project, runIds)),
    settle(() => store.enrollmentsByIds(project, enrollmentIds)),
  ]);

  const policy =
    scopedPolicy(c) ?? compatibilityPolicy(c.get("effectiveRole") ?? "viewer");
  const { next_cursor: _unused, ...body } = assembleRuntimeView({
    server_now: serverNow,
    page,
    runs,
    enrollments,
    scope: runtimeVisibilityScope(c),
    presence_allowed: policy.capabilities.includes("presence:read"),
    attach_allowed: policy.capabilities.includes("agent-bindings:attach"),
    next_cursor: null,
  });
  return { body, next_after: page.next_after };
}

const SOURCE_RANK = { ok: 0, forbidden: 1, unavailable: 2 } as const;

/** The least healthy status each source reported across pages. */
function worstSources(
  a: RuntimeViewBody["sources"],
  b: RuntimeViewBody["sources"],
): RuntimeViewBody["sources"] {
  const pick = (key: keyof RuntimeViewBody["sources"]) =>
    SOURCE_RANK[b[key]] > SOURCE_RANK[a[key]] ? b[key] : a[key];
  return {
    agents: pick("agents"),
    runs: pick("runs"),
    enrollments: pick("enrollments"),
    presence: pick("presence"),
  };
}

/**
 * Scan up to `RUNTIME_ATTENTION_SCAN_LIMIT` agents page by page, keep the rows
 * whose current occupant needs attention, then page over those matches by
 * agent id. `total` counts every match in the scan.
 */
async function loadAttention(
  c: RuntimeViewContext,
  query: RuntimeViewQuery,
  store: RuntimeStoreReader,
): Promise<Response> {
  // Reject a malformed cursor before paying for the scan.
  const from = query.cursor ? decodeRuntimeCursor(query.cursor) : null;
  let after: string | null = null;
  let scanned = 0;
  let complete = true;
  let first: RuntimeViewBody | null = null;
  let sources: RuntimeViewBody["sources"] | null = null;
  const matches: RuntimeViewBody["rows"] = [];
  for (;;) {
    const params = new URLSearchParams({
      limit: String(RUNTIME_VIEW_MAX_LIMIT),
    });
    if (after) params.set("after", after);
    const result = await loadPage(c, params, store);
    if (result instanceof Response) return result;
    first ??= result.body;
    sources = sources
      ? worstSources(sources, result.body.sources)
      : result.body.sources;
    scanned += result.body.rows.length;
    for (const row of result.body.rows)
      if (row.current && runtimeAttention(row.current.observation))
        matches.push(row);
    if (!result.next_after) break;
    if (scanned >= RUNTIME_ATTENTION_SCAN_LIMIT) {
      complete = false;
      break;
    }
    after = result.next_after;
  }
  const remaining = from
    ? matches.filter((row) => row.agent.id > from)
    : matches;
  const rows = remaining.slice(0, query.limit);
  const last = rows.at(-1);
  const body: RuntimeViewResponse = {
    ok: true,
    server_now: first?.server_now ?? Date.now(),
    sources: sources ?? {
      agents: "ok",
      runs: "ok",
      enrollments: "ok",
      presence: "ok",
    },
    rows,
    next_cursor:
      remaining.length > rows.length && last
        ? encodeRuntimeCursor(last.agent.id)
        : null,
    total: matches.length,
    scan: { agents: scanned, complete },
  };
  return Response.json(RuntimeViewResponseSchema.parse(body), {
    headers: { "Cache-Control": "private, no-store" },
  });
}

/** The runtime projection for one page, or for the attention filter. */
export async function loadRuntimeView(
  c: RuntimeViewContext,
  query: RuntimeViewQuery,
  store: RuntimeStoreReader = new RuntimeStore(c.env.DB),
): Promise<Response> {
  if (query.filter === "attention") return loadAttention(c, query, store);
  const params = new URLSearchParams({ limit: String(query.limit) });
  if (query.agent) params.set("agent", query.agent);
  else if (query.cursor) params.set("after", decodeRuntimeCursor(query.cursor));
  const result = await loadPage(c, params, store);
  if (result instanceof Response) return result;
  const body: RuntimeViewResponse = {
    ...result.body,
    next_cursor: result.next_after
      ? encodeRuntimeCursor(result.next_after)
      : null,
  };
  return Response.json(RuntimeViewResponseSchema.parse(body), {
    headers: { "Cache-Control": "private, no-store" },
  });
}
