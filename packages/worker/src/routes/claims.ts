import {
  AcquireRequestSchema,
  ReleaseRequestSchema,
  RenewRequestSchema,
} from "@tila/schemas";
import { Hono } from "hono";
import { analyticsCtxFrom } from "../lib/analytics";
import { forwardToDO } from "../lib/do-forward";
import { zodValidationError } from "../lib/validation";
import { requirePermission } from "../middleware/permission";
import type { Env, HonoVariables } from "../types";

export const claims = new Hono<{
  Bindings: Env;
  Variables: HonoVariables;
}>();

// GET /projects/:projectId/claims -> DO GET /coord/claims
claims.get("/", requirePermission("read"), async (c) => {
  const stub = c.get("doStub");
  return forwardToDO(
    stub,
    "/coord/claims",
    "GET",
    undefined,
    undefined,
    analyticsCtxFrom(c),
  );
});

// POST /projects/:projectId/claims/acquire -> DO POST /coord/acquire
claims.post("/acquire", requirePermission("write"), async (c) => {
  const raw = await c.req.json();
  const parsed = AcquireRequestSchema.safeParse(raw);
  if (!parsed.success) return zodValidationError(c, parsed.error);
  const stub = c.get("doStub");
  const tokenResult = c.get("tokenResult");

  // Presence mode: route to heartbeat instead of claims table
  if (parsed.data.mode === "presence") {
    const hbResponse = await forwardToDO(
      stub,
      "/coord/heartbeat",
      "POST",
      {
        machine: tokenResult.name,
        info: parsed.data.metadata ?? {},
      },
      undefined,
      analyticsCtxFrom(c),
    );
    if (!hbResponse.ok) {
      return hbResponse;
    }
    // Return synthetic acquire response shape with fence=0 (no fence discipline for presence)
    return c.json({
      ok: true,
      fence: 0,
      expires_at: Date.now() + parsed.data.ttl_ms,
    });
  }

  return forwardToDO(
    stub,
    "/coord/acquire",
    "POST",
    {
      ...parsed.data,
      machine: tokenResult.name,
      user: tokenResult.name,
      actor_token_id: tokenResult.tokenId,
      source: c.get("source"),
      source_version: c.get("sourceVersion"),
    },
    undefined,
    analyticsCtxFrom(c),
  );
});

// POST /projects/:projectId/claims/renew -> DO POST /coord/renew
claims.post("/renew", requirePermission("write"), async (c) => {
  const raw = await c.req.json();
  const parsed = RenewRequestSchema.safeParse(raw);
  if (!parsed.success) return zodValidationError(c, parsed.error);
  const stub = c.get("doStub");
  const tokenResult = c.get("tokenResult");
  return forwardToDO(
    stub,
    "/coord/renew",
    "POST",
    {
      ...parsed.data,
      machine: tokenResult.name,
      user: tokenResult.name,
      actor_token_id: tokenResult.tokenId,
      source: c.get("source"),
      source_version: c.get("sourceVersion"),
    },
    undefined,
    analyticsCtxFrom(c),
  );
});

// POST /projects/:projectId/claims/release -> DO POST /coord/release
claims.post("/release", requirePermission("write"), async (c) => {
  const raw = await c.req.json();
  const parsed = ReleaseRequestSchema.safeParse(raw);
  if (!parsed.success) return zodValidationError(c, parsed.error);
  const stub = c.get("doStub");
  const tokenResult = c.get("tokenResult");
  return forwardToDO(
    stub,
    "/coord/release",
    "POST",
    {
      ...parsed.data,
      actor: `${tokenResult.name}/${tokenResult.name}`,
      actor_token_id: tokenResult.tokenId,
      source: c.get("source"),
      source_version: c.get("sourceVersion"),
    },
    undefined,
    analyticsCtxFrom(c),
  );
});

// GET /projects/:projectId/claims/state/:resource -> DO GET /coord/state?resource=
claims.get("/state/:resource", requirePermission("read"), async (c) => {
  const resource = c.req.param("resource");
  const stub = c.get("doStub");
  return forwardToDO(
    stub,
    "/coord/state",
    "GET",
    undefined,
    { resource },
    analyticsCtxFrom(c),
  );
});
