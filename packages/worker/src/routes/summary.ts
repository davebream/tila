import { Hono } from "hono";
import { analyticsCtxFrom } from "../lib/analytics";
import { forwardToDO } from "../lib/do-forward";
import type { Env, HonoVariables } from "../types";

export const summary = new Hono<{ Bindings: Env; Variables: HonoVariables }>();

// GET /projects/:projectId/summary -> DO GET /summary
summary.get("/", async (c) => {
  const stub = c.get("doStub");
  return forwardToDO(
    stub,
    "/summary",
    "GET",
    undefined,
    undefined,
    analyticsCtxFrom(c),
  );
});
