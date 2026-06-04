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

// GET /projects/:projectId/search -- unified full-text search across entities and artifacts
search.get("/", requirePermission("read"), async (c) => {
  const raw = c.req.query();
  const parsed = UnifiedSearchQuerySchema.safeParse(raw);
  if (!parsed.success) return zodValidationError(c, parsed.error);

  const { q, limit } = parsed.data;
  const query: Record<string, string> = { q };
  if (limit !== undefined) query.limit = String(limit);

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
