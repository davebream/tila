import {
  CUSTOM_REPORT_BODY_BYTES,
  CustomEventNameSchema,
  JournalAppendRequestSchema,
  JournalCorrelationIdSchema,
  JournalIdempotencyKeySchema,
  journalValidationCode,
} from "@tila/schemas";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { analyticsCtxFrom } from "../lib/analytics";
import { forwardToDO } from "../lib/do-forward";
import { requirePermission } from "../middleware/permission";
import { identityPayload } from "../middleware/request-identity";
import type { Env, HonoVariables } from "../types";

export const journal = new Hono<{
  Bindings: Env;
  Variables: HonoVariables;
}>();

// POST /projects/:projectId/journal -> DO POST /journal/append
journal.post(
  "/",
  bodyLimit({
    maxSize: CUSTOM_REPORT_BODY_BYTES,
    onError: (c) =>
      c.json(
        {
          ok: false,
          error: {
            code: "payload-too-large",
            message: "Report request exceeds 64 KiB",
            retryable: false,
          },
        },
        413,
      ),
  }),
  requirePermission("write"),
  async (c) => {
    const body = await c.req.json().catch(() => null);
    const input = JournalAppendRequestSchema.safeParse(body);
    const key = JournalIdempotencyKeySchema.safeParse(
      c.req.header("Idempotency-Key"),
    );
    if (!input.success || !key.success) {
      const error = !input.success
        ? input.error
        : !key.success
          ? key.error
          : undefined;
      const code = error ? journalValidationCode(error) : "validation-error";
      return c.json(
        {
          ok: false,
          error: {
            code,
            message: error?.message ?? "Invalid report",
            retryable: false,
          },
        },
        code === "payload-too-large" ? 413 : 400,
      );
    }
    return forwardToDO(
      c.get("doStub"),
      "/journal/append",
      "POST",
      {
        ...identityPayload(c),
        project_id: c.get("projectId"),
        authorized_role: c.get("effectiveRole") ?? "viewer",
        input: input.data,
        idempotency_key: key.data,
      },
      undefined,
      analyticsCtxFrom(c),
    );
  },
);

// GET /projects/:projectId/journal -> DO GET /journal/list
journal.get("/", async (c) => {
  const stub = c.get("doStub");
  const query: Record<string, string> = {};
  for (const [name, validator] of [
    ["event_name", CustomEventNameSchema],
    ["correlation_id", JournalCorrelationIdSchema],
  ] as const) {
    const value = c.req.query(name);
    if (value !== undefined) {
      const parsed = validator.safeParse(value);
      if (!parsed.success)
        return c.json(
          {
            ok: false,
            error: {
              code: "validation-error",
              message: `Invalid ${name}`,
              retryable: false,
            },
          },
          400,
        );
      query[name] = parsed.data;
    }
  }
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
