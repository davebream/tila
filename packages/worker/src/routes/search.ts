import { UnifiedSearchQuerySchema } from "@tila/schemas";
import { Hono } from "hono";
import { analyticsCtxFrom } from "../lib/analytics";
import { forwardToDO } from "../lib/do-forward";
import { zodValidationError } from "../lib/validation";
import { requirePermission } from "../middleware/permission";
import type { Env, HonoVariables } from "../types";

export const search = new Hono<{
  Bindings: Env;
  Variables: HonoVariables;
}>();

// GET /projects/:projectId/search -- unified full-text search across tasks, records and artifacts.
// The DO narrows kinds to what the credential may read and reports that in `scope`.
search.get("/", requirePermission("read"), async (c) => {
  const raw = c.req.query();
  const parsed = UnifiedSearchQuerySchema.safeParse(raw);
  if (!parsed.success) return zodValidationError(c, parsed.error);

  const {
    q,
    limit,
    tag_filter: tagFilter,
    kind,
    type,
    cursor,
    syntax,
  } = parsed.data;
  const query: Record<string, string> = { q, syntax };
  if (limit !== undefined) query.limit = String(limit);
  if (tagFilter?.length) query.tag_filter = tagFilter.join(",");
  if (kind?.length) query.kind = kind.join(",");
  if (type?.length) query.type = type.join(",");
  if (cursor) query.cursor = cursor;

  const stub = c.get("doStub");
  return forwardToDO(
    stub,
    "/search",
    "GET",
    undefined,
    query,
    analyticsCtxFrom(c),
  );
});

// POST /projects/:projectId/search/reindex -- start a batched FTS reindex job
search.post("/reindex", requirePermission("admin"), async (c) => {
  const stub = c.get("doStub");
  const body = await c.req.json().catch(() => ({}));
  return forwardToDO(
    stub,
    "/search/reindex",
    "POST",
    body,
    undefined,
    analyticsCtxFrom(c),
  );
});

// GET /projects/:projectId/search/reindex/status -- check reindex job status
search.get("/reindex/status", requirePermission("admin"), async (c) => {
  const stub = c.get("doStub");
  return forwardToDO(
    stub,
    "/search/reindex/status",
    "GET",
    undefined,
    undefined,
    analyticsCtxFrom(c),
  );
});
