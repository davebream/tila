import { SendSignalRequestSchema } from "@tila/schemas";
import { Hono } from "hono";
import { analyticsCtxFrom } from "../lib/analytics";
import { forwardToDO } from "../lib/do-forward";
import { zodValidationError } from "../lib/validation";
import { requirePermission } from "../middleware/permission";
import type { Env, HonoVariables } from "../types";

export const signals = new Hono<{
  Bindings: Env;
  Variables: HonoVariables;
}>();

// GET /projects/:projectId/signals -> DO GET /signal/inbox?target=<tokenName>
signals.get("/", async (c) => {
  const stub = c.get("doStub");
  const tokenResult = c.get("tokenResult");
  return forwardToDO(
    stub,
    "/signal/inbox",
    "GET",
    undefined,
    { target: tokenResult.name },
    analyticsCtxFrom(c),
  );
});

// POST /projects/:projectId/signals/send -> DO POST /signal/send
signals.post("/send", requirePermission("write"), async (c) => {
  const raw = await c.req.json();
  const parsed = SendSignalRequestSchema.safeParse(raw);
  if (!parsed.success) return zodValidationError(c, parsed.error);
  const stub = c.get("doStub");
  const tokenResult = c.get("tokenResult");
  return forwardToDO(
    stub,
    "/signal/send",
    "POST",
    {
      ...parsed.data,
      created_by: tokenResult.name,
      source: c.get("source"),
      source_version: c.get("sourceVersion"),
    },
    undefined,
    analyticsCtxFrom(c),
  );
});

// POST /projects/:projectId/signals/:id/ack -> DO POST /signal/:id/ack
signals.post("/:id/ack", async (c) => {
  const signalId = c.req.param("id");
  const stub = c.get("doStub");
  return forwardToDO(
    stub,
    `/signal/${signalId}/ack`,
    "POST",
    {},
    undefined,
    analyticsCtxFrom(c),
  );
});
