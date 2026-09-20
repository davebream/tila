import {
  SendSignalRequestSchema,
  SetSignalGroupRequestSchema,
  SignalGroupIdSchema,
} from "@tila/schemas";
import { Hono } from "hono";
import { analyticsCtxFrom } from "../lib/analytics";
import { forwardToDO } from "../lib/do-forward";
import { zodValidationError } from "../lib/validation";
import { requirePermission } from "../middleware/permission";
import { identityPayload } from "../middleware/request-identity";
import type { Env, HonoVariables } from "../types";

export const signals = new Hono<{
  Bindings: Env;
  Variables: HonoVariables;
}>();

function participantRequired(c: Parameters<typeof identityPayload>[0]) {
  return !c.get("participantId");
}

function actor(c: Parameters<typeof identityPayload>[0]) {
  const canonical = identityPayload(c);
  return {
    principal_id: canonical.principal_id,
    participant_id: canonical.participant_id,
    display_name: c.get("tokenResult").name,
    environment: canonical.environment,
  };
}

signals.get("/", requirePermission("read"), async (c) => {
  if (participantRequired(c)) {
    return c.json(
      {
        ok: false,
        error: {
          code: "participant-required",
          message: "X-Tila-Participant-Id is required for signal inboxes",
          retryable: false,
        },
      },
      400,
    );
  }
  const canonical = identityPayload(c);
  return forwardToDO(
    c.get("doStub"),
    "/signal/inbox",
    "GET",
    undefined,
    {
      principal_id: canonical.principal_id,
      participant_id: canonical.participant_id,
    },
    analyticsCtxFrom(c),
  );
});

signals.get("/history", requirePermission("admin"), async (c) =>
  forwardToDO(
    c.get("doStub"),
    "/signal/history",
    "GET",
    undefined,
    {
      ...(c.req.query("limit") ? { limit: c.req.query("limit") } : {}),
      ...(c.req.query("cursor") ? { cursor: c.req.query("cursor") } : {}),
    },
    analyticsCtxFrom(c),
  ),
);

signals.get("/groups", requirePermission("read"), async (c) =>
  forwardToDO(
    c.get("doStub"),
    "/signal/groups",
    "GET",
    undefined,
    undefined,
    analyticsCtxFrom(c),
  ),
);

signals.get("/groups/:groupId", requirePermission("read"), async (c) => {
  const groupId = SignalGroupIdSchema.safeParse(c.req.param("groupId"));
  if (!groupId.success) return zodValidationError(c, groupId.error);
  return forwardToDO(
    c.get("doStub"),
    `/signal/groups/${encodeURIComponent(groupId.data)}`,
    "GET",
    undefined,
    undefined,
    analyticsCtxFrom(c),
  );
});

signals.put("/groups/:groupId", requirePermission("admin"), async (c) => {
  const groupId = SignalGroupIdSchema.safeParse(c.req.param("groupId"));
  const raw = await c.req.json();
  const input = SetSignalGroupRequestSchema.safeParse(raw);
  if (!groupId.success) return zodValidationError(c, groupId.error);
  if (!input.success) return zodValidationError(c, input.error);
  return forwardToDO(
    c.get("doStub"),
    `/signal/groups/${encodeURIComponent(groupId.data)}`,
    "PUT",
    { ...input.data, actor: actor(c) },
    undefined,
    analyticsCtxFrom(c),
  );
});

signals.delete("/groups/:groupId", requirePermission("admin"), async (c) => {
  const groupId = SignalGroupIdSchema.safeParse(c.req.param("groupId"));
  if (!groupId.success) return zodValidationError(c, groupId.error);
  return forwardToDO(
    c.get("doStub"),
    `/signal/groups/${encodeURIComponent(groupId.data)}`,
    "DELETE",
    undefined,
    undefined,
    analyticsCtxFrom(c),
  );
});

signals.post("/send", requirePermission("write"), async (c) => {
  const raw = await c.req.json();
  if (
    typeof raw === "object" &&
    raw !== null &&
    typeof (raw as { target?: unknown }).target === "string"
  ) {
    return c.json(
      {
        ok: false,
        error: {
          code: "validation-error",
          message:
            "String signal targets are no longer supported; upgrade the client and use a typed target object",
          retryable: false,
        },
      },
      400,
    );
  }
  const parsed = SendSignalRequestSchema.safeParse(raw);
  if (!parsed.success) return zodValidationError(c, parsed.error);
  return forwardToDO(
    c.get("doStub"),
    "/signal/send",
    "POST",
    { ...parsed.data, sender: actor(c) },
    undefined,
    analyticsCtxFrom(c),
  );
});

signals.post("/:id/ack", requirePermission("write"), async (c) =>
  forwardToDO(
    c.get("doStub"),
    `/signal/${c.req.param("id")}/ack`,
    "POST",
    actor(c),
    undefined,
    analyticsCtxFrom(c),
  ),
);
