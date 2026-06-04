import { InstantiateTemplateRequestSchema } from "@tila/schemas";
import { Hono } from "hono";
import { analyticsCtxFrom } from "../lib/analytics";
import { forwardToDO } from "../lib/do-forward";
import { zodValidationError } from "../lib/validation";
import { requirePermission } from "../middleware/permission";
import type { Env, HonoVariables } from "../types";

export const templates = new Hono<{
  Bindings: Env;
  Variables: HonoVariables;
}>();

// GET /projects/:projectId/templates -> DO GET /template/list
templates.get("/", async (c) => {
  const stub = c.get("doStub");
  return forwardToDO(
    stub,
    "/template/list",
    "GET",
    undefined,
    undefined,
    analyticsCtxFrom(c),
  );
});

// POST /projects/:projectId/templates/instantiate -> DO POST /template/instantiate
templates.post("/instantiate", requirePermission("write"), async (c) => {
  const raw = await c.req.json();
  const parsed = InstantiateTemplateRequestSchema.safeParse(raw);
  if (!parsed.success) return zodValidationError(c, parsed.error);
  const stub = c.get("doStub");
  const tokenResult = c.get("tokenResult");
  return forwardToDO(
    stub,
    "/template/instantiate",
    "POST",
    {
      ...parsed.data,
      actor: tokenResult.name,
      actor_token_id: tokenResult.tokenId,
      source: c.get("source"),
      source_version: c.get("sourceVersion"),
    },
    undefined,
    analyticsCtxFrom(c),
  );
});
