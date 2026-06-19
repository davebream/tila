import { ApplyStrategySchema } from "@tila/schemas";
import { Hono } from "hono";
import { analyticsCtxFrom } from "../lib/analytics";
import { forwardToDO } from "../lib/do-forward";
import { bustSchemaCache } from "../lib/schema-cache";
import { requirePermission } from "../middleware/permission";
import type { Env, HonoVariables } from "../types";

export const schemaRoutes = new Hono<{
  Bindings: Env;
  Variables: HonoVariables;
}>();

// GET /projects/:projectId/schema -> DO GET /schema/current
schemaRoutes.get("/", async (c) => {
  const stub = c.get("doStub");
  return forwardToDO(
    stub,
    "/schema/current",
    "GET",
    undefined,
    undefined,
    analyticsCtxFrom(c),
  );
});

// POST /projects/:projectId/schema/preview -> DO POST /schema/preview
schemaRoutes.post("/preview", requirePermission("write"), async (c) => {
  const raw = await c.req.json();
  if (!raw?.definition || typeof raw.definition !== "string") {
    return c.json(
      {
        ok: false,
        error: {
          code: "validation-error",
          message: "definition is required",
          retryable: false,
        },
      },
      400,
    );
  }

  const stub = c.get("doStub");
  return forwardToDO(
    stub,
    "/schema/preview",
    "POST",
    { definition: raw.definition },
    undefined,
    analyticsCtxFrom(c),
  );
});

// POST /projects/:projectId/schema -> DO POST /schema/apply
schemaRoutes.post("/", requirePermission("write"), async (c) => {
  const raw = await c.req.json();
  if (!raw?.definition || typeof raw.definition !== "string") {
    return c.json(
      {
        ok: false,
        error: {
          code: "validation-error",
          message: "definition is required",
          retryable: false,
        },
      },
      400,
    );
  }

  // Validate strategy if provided
  if (raw.strategy !== undefined) {
    const parsed = ApplyStrategySchema.safeParse(raw.strategy);
    if (!parsed.success) {
      return c.json(
        {
          ok: false,
          error: {
            code: "validation-error",
            message: `Invalid strategy "${raw.strategy}". Valid: relax, force`,
            retryable: false,
          },
        },
        400,
      );
    }
  }

  const tokenResult = c.get("tokenResult");
  const stub = c.get("doStub");
  const res = await forwardToDO(
    stub,
    "/schema/apply",
    "POST",
    {
      definition: raw.definition,
      applied_by: tokenResult.name,
      strategy: raw.strategy,
      actor_token_id: tokenResult.tokenId,
      source: c.get("source"),
      source_version: c.get("sourceVersion"),
    },
    undefined,
    analyticsCtxFrom(c),
  );

  // Bust the per-isolate schema cache on a successful schema write (both
  // CREATE and UPDATE land here via /schema/apply). This enforces the
  // ≤30s cross-isolate staleness contract for the local isolate: the next
  // schema-validation call in this isolate will re-fetch from the DO.
  if (res.ok) {
    bustSchemaCache(c.get("projectId"));
  }

  return res;
});
