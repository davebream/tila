import {
  CreateGateRequestSchema,
  ResolveGateRequestSchema,
} from "@tila/schemas";
import { Hono } from "hono";
import { analyticsCtxFrom } from "../lib/analytics";
import { forwardToDO } from "../lib/do-forward";
import { zodValidationError } from "../lib/validation";
import { requirePermission } from "../middleware/permission";
import type { Env, HonoVariables } from "../types";

export const gates = new Hono<{
  Bindings: Env;
  Variables: HonoVariables;
}>();

// GET /projects/:projectId/gates -> DO GET /gate
gates.get("/", async (c) => {
  const stub = c.get("doStub");
  const resource = c.req.query("resource") ?? undefined;
  const status = c.req.query("status") ?? undefined;
  const limit = c.req.query("limit") ?? undefined;
  const query: Record<string, string> = {};
  if (resource) query.resource = resource;
  if (status) query.status = status;
  if (limit) query.limit = limit;
  return forwardToDO(
    stub,
    "/gate",
    "GET",
    undefined,
    Object.keys(query).length > 0 ? query : undefined,
    analyticsCtxFrom(c),
  );
});

// POST /projects/:projectId/gates -> DO POST /gate/create
gates.post("/", requirePermission("write"), async (c) => {
  const raw = await c.req.json();
  const parsed = CreateGateRequestSchema.safeParse(raw);
  if (!parsed.success) return zodValidationError(c, parsed.error);
  const stub = c.get("doStub");
  const tokenResult = c.get("tokenResult");
  const id = `gate-${crypto.randomUUID()}`;
  return forwardToDO(
    stub,
    "/gate/create",
    "POST",
    {
      ...parsed.data,
      id,
      actor: tokenResult.name,
      actor_token_id: tokenResult.tokenId,
      source: c.get("source"),
      source_version: c.get("sourceVersion"),
    },
    undefined,
    analyticsCtxFrom(c),
  );
});

// POST /projects/:projectId/gates/:gateId/resolve -> DO POST /gate/:gateId/resolve
gates.post("/:gateId/resolve", requirePermission("write"), async (c) => {
  const gateId = c.req.param("gateId");
  const raw = await c.req.json();
  const parsed = ResolveGateRequestSchema.safeParse(raw);
  if (!parsed.success) return zodValidationError(c, parsed.error);
  const stub = c.get("doStub");
  const tokenResult = c.get("tokenResult");
  return forwardToDO(
    stub,
    `/gate/${gateId}/resolve`,
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

// DELETE /projects/:projectId/gates/:gateId -> DO DELETE /gate/:gateId
gates.delete("/:gateId", requirePermission("write"), async (c) => {
  const gateId = c.req.param("gateId");
  const stub = c.get("doStub");
  const tokenResult = c.get("tokenResult");
  return forwardToDO(
    stub,
    `/gate/${gateId}`,
    "DELETE",
    {
      actor: tokenResult.name,
      actor_token_id: tokenResult.tokenId,
      source: c.get("source"),
      source_version: c.get("sourceVersion"),
    },
    undefined,
    analyticsCtxFrom(c),
  );
});
