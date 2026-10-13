import {
  ApplyStrategySchema,
  DEFINITION_MAX_BYTES,
  DEFINITION_REQUEST_MAX_BYTES,
  SchemaApplyRequestSchema,
  definitionByteLength,
} from "@tila/schemas";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { analyticsCtxFrom } from "../lib/analytics";
import { forwardToDO } from "../lib/do-forward";
import { bustSchemaCache } from "../lib/schema-cache";
import { requirePermission } from "../middleware/permission";
import { identityPayload } from "../middleware/request-identity";
import type { Env, HonoVariables } from "../types";

export const schemaRoutes = new Hono<{
  Bindings: Env;
  Variables: HonoVariables;
}>();

function definitionTooLarge(c: Context, message: string) {
  return c.json(
    {
      ok: false,
      error: { code: "payload-too-large", message, retryable: false },
    },
    413,
  );
}

/**
 * Request size limit for schema writes. Mounted on the project router ahead
 * of the idempotency middleware, which reads the whole body to hash it.
 */
export const schemaBodyLimit = bodyLimit({
  maxSize: DEFINITION_REQUEST_MAX_BYTES,
  onError: (c) =>
    definitionTooLarge(
      c,
      `Schema request exceeds ${DEFINITION_REQUEST_MAX_BYTES / 1024} KiB`,
    ),
});

/** 413 response when any definition text exceeds the definition limit. */
function oversizeDefinition(c: Context, body: Record<string, unknown>) {
  for (const field of ["definition", "reviewed_definition"] as const) {
    const text = body[field];
    if (typeof text !== "string") continue;
    const bytes = definitionByteLength(text);
    if (bytes > DEFINITION_MAX_BYTES)
      return definitionTooLarge(
        c,
        `${field} is ${Math.ceil(bytes / 1024)} KiB; definitions are limited to ${DEFINITION_MAX_BYTES / 1024} KiB`,
      );
  }
  return null;
}

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
  const oversize = oversizeDefinition(c, raw);
  if (oversize) return oversize;

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
  const oversize = oversizeDefinition(c, raw);
  if (oversize) return oversize;

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
  const parsed = SchemaApplyRequestSchema.safeParse(raw);
  if (!parsed.success)
    return c.json(
      {
        ok: false,
        error: {
          code: "validation-error",
          message: parsed.error.message,
          retryable: false,
        },
      },
      400,
    );
  const stub = c.get("doStub");
  const res = await forwardToDO(
    stub,
    "/schema/apply",
    "POST",
    {
      ...parsed.data,
      applied_by: tokenResult.name,
      idempotency_key: c.get("idempotencyKey") ?? parsed.data.idempotency_key,
      ...identityPayload(c),
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

schemaRoutes.get("/history", async (c) =>
  forwardToDO(
    c.get("doStub"),
    `/schema/history?${new URL(c.req.url).searchParams}`,
    "GET",
    undefined,
    undefined,
    analyticsCtxFrom(c),
  ),
);
