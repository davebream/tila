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
  const resource = c.req.query("resource");
  if (resource) query.resource = resource;
  const kind = c.req.query("kind");
  if (kind) query.kind = kind;
  const source = c.req.query("source");
  if (source) query.source = source;
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
