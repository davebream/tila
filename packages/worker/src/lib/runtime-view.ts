import { type Settled, assembleRuntimeView } from "@tila/core";
import {
  AgentRuntimePageSchema,
  type RuntimeViewQuery,
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

/**
 * Join the DO agent page with D1 runs and enrollments. A DO failure is
 * returned as-is so the client never mistakes it for "no agents"; a D1 failure
 * degrades to per-source `unavailable` with `unknown` occupancy.
 */
export async function loadRuntimeView(
  c: RuntimeViewContext,
  query: RuntimeViewQuery,
  store: Pick<
    RuntimeStore,
    "runsByIds" | "enrollmentsByIds"
  > = new RuntimeStore(c.env.DB),
): Promise<Response> {
  const params = new URLSearchParams({ limit: String(query.limit) });
  if (query.agent) params.set("agent", query.agent);
  else if (query.cursor) params.set("after", decodeRuntimeCursor(query.cursor));
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
  const body = assembleRuntimeView({
    server_now: serverNow,
    page,
    runs,
    enrollments,
    scope: runtimeVisibilityScope(c),
    presence_allowed: policy.capabilities.includes("presence:read"),
    attach_allowed: policy.capabilities.includes("agent-bindings:attach"),
    next_cursor: page.next_after ? encodeRuntimeCursor(page.next_after) : null,
  });
  return Response.json(RuntimeViewResponseSchema.parse(body), {
    headers: { "Cache-Control": "private, no-store" },
  });
}
