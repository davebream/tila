import { Hono } from "hono";
import { analyticsCtxFrom } from "../lib/analytics";
import { forwardToDO } from "../lib/do-forward";
import type { Env, HonoVariables } from "../types";

export const journal = new Hono<{
  Bindings: Env;
  Variables: HonoVariables;
}>();

// GET /projects/:projectId/journal -> DO GET /journal/list
journal.get("/", async (c) => {
  const stub = c.get("doStub");
  const query: Record<string, string> = {};
  // A task's history spans two journal resources (the bare id for task
  // events, `<type>:<id>` for claims), so `resource` may repeat (max 10).
  const resources = (c.req.queries("resource") ?? []).filter(Boolean);
  if (resources.length > 10)
    return c.json(
      {
        ok: false,
        error: {
          code: "validation-error",
          message: "At most 10 resource values are allowed",
          retryable: false,
        },
      },
      400,
    );
  if (resources.length === 1) query.resource = resources[0];
  else if (resources.length > 1) query.resources = JSON.stringify(resources);
  const kind = c.req.query("kind");
  if (kind) query.kind = kind;
  const clientName = c.req.query("client_name");
  if (clientName) query.client_name = clientName;
  const afterSeq = c.req.query("after_seq");
  if (afterSeq) query.after_seq = afterSeq;
  const limit = c.req.query("limit");
  if (limit) query.limit = limit;
  return forwardToDO(
    stub,
    "/journal/list",
    "GET",
    undefined,
    query,
    analyticsCtxFrom(c),
  );
});
