import { PresenceHeartbeatRequestSchema } from "@tila/schemas";
import { Hono } from "hono";
import { analyticsCtxFrom } from "../lib/analytics";
import { forwardToDO } from "../lib/do-forward";
import { zodValidationError } from "../lib/validation";
import type { Env, HonoVariables } from "../types";

export const presence = new Hono<{
  Bindings: Env;
  Variables: HonoVariables;
}>();

// GET /projects/:projectId/presence -> DO GET /coord/presence
presence.get("/", async (c) => {
  const stub = c.get("doStub");
  return forwardToDO(
    stub,
    "/coord/presence",
    "GET",
    undefined,
    undefined,
    analyticsCtxFrom(c),
  );
});

// GET /projects/:projectId/presence/all -> DO GET /coord/presence/all
presence.get("/all", async (c) => {
  const stub = c.get("doStub");
  return forwardToDO(
    stub,
    "/coord/presence/all",
    "GET",
    undefined,
    undefined,
    analyticsCtxFrom(c),
  );
});

// POST /projects/:projectId/presence/heartbeat -> DO POST /coord/heartbeat
presence.post("/heartbeat", async (c) => {
  const raw = await c.req.json();
  const parsed = PresenceHeartbeatRequestSchema.safeParse(raw);
  if (!parsed.success) return zodValidationError(c, parsed.error);
  const stub = c.get("doStub");
  const tokenResult = c.get("tokenResult");
  return forwardToDO(
    stub,
    "/coord/heartbeat",
    "POST",
    {
      machine: tokenResult.name,
      info: parsed.data.info,
    },
    undefined,
    analyticsCtxFrom(c),
  );
});
