import { createR2JournalArchiveReader } from "@tila/backend-r2";
import {
  ContinuityError,
  type ReentrySnapshot,
  type ReplaySnapshot,
  completeReplay,
} from "@tila/core";
import {
  HandoffCreateRequestSchema,
  HandoffListRequestSchema,
  JournalAcknowledgeRequestSchema,
  JournalReplayRequestSchema,
  ReentryRequestSchema,
} from "@tila/schemas";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { ZodError } from "zod";
import { analyticsCtxFrom } from "../lib/analytics";
import { forwardToDO } from "../lib/do-forward";
import { zodValidationError } from "../lib/validation";
import { requirePermission } from "../middleware/permission";
import { identityPayload } from "../middleware/request-identity";
import type { Env, HonoVariables } from "../types";

export const continuity = new Hono<{
  Bindings: Env;
  Variables: HonoVariables;
}>();
continuity.onError((error, c) => {
  if (error instanceof ZodError) return zodValidationError(c, error);
  if (error instanceof ContinuityError)
    return c.json(
      {
        ok: false,
        error: {
          code: error.code,
          message: error.message,
          retryable: error.status === 503,
        },
      },
      error.status as ContentfulStatusCode,
    );
  throw error;
});

function queryValues(query: Record<string, string>) {
  return Object.fromEntries(
    Object.entries(query).map(([key, value]) => [
      key,
      ["after_seq", "through_seq", "before_seq", "limit"].includes(key)
        ? Number(value)
        : value,
    ]),
  );
}
const strings = (query: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(query)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, String(value)]),
  );

// Participant-scoped reads require an explicit participant just like signal inboxes.
continuity.use("*", async (c, next) => {
  if (
    !/\/(?:journal\/(?:replay|cursor)|handoffs(?:\/[^/]+)?|reentry)\/?$/.test(
      c.req.path,
    )
  )
    return next();
  if (!c.get("participantId"))
    return c.json(
      {
        ok: false,
        error: {
          code: "participant-required",
          message: "X-Tila-Participant-Id is required for continuity workflows",
          retryable: false,
        },
      },
      400,
    );
  await next();
});
continuity.get("/journal/replay", requirePermission("read"), async (c) => {
  const input = JournalReplayRequestSchema.parse(queryValues(c.req.query()));
  const response = await forwardToDO(
    c.get("doStub"),
    "/journal/replay",
    "GET",
    undefined,
    strings(input),
    analyticsCtxFrom(c),
  );
  if (!response.ok) return response;
  const snapshot = (await response.json()) as ReplaySnapshot;
  return c.json(
    await completeReplay(
      snapshot,
      createR2JournalArchiveReader(c.env.ARTIFACTS, c.get("projectId")),
    ),
  );
});
continuity.get("/journal/cursor", requirePermission("read"), (c) => {
  const identity = identityPayload(c);
  return forwardToDO(
    c.get("doStub"),
    "/journal/cursor",
    "GET",
    undefined,
    {
      principal_id: identity.principal_id,
      participant_id: identity.participant_id,
    },
    analyticsCtxFrom(c),
  );
});
continuity.put("/journal/cursor", requirePermission("write"), async (c) =>
  forwardToDO(
    c.get("doStub"),
    "/journal/cursor",
    "PUT",
    {
      identity: identityPayload(c),
      input: JournalAcknowledgeRequestSchema.parse(await c.req.json()),
    },
    undefined,
    analyticsCtxFrom(c),
  ),
);
continuity.post("/handoffs", requirePermission("write"), async (c) =>
  forwardToDO(
    c.get("doStub"),
    "/handoffs",
    "POST",
    {
      identity: identityPayload(c),
      input: HandoffCreateRequestSchema.parse(await c.req.json()),
    },
    undefined,
    analyticsCtxFrom(c),
  ),
);
continuity.get("/handoffs", requirePermission("read"), (c) => {
  const input = HandoffListRequestSchema.parse(queryValues(c.req.query()));
  const identity = identityPayload(c);
  return forwardToDO(
    c.get("doStub"),
    "/handoffs",
    "GET",
    undefined,
    {
      ...strings(input),
      principal_id: identity.principal_id,
      participant_id: identity.participant_id,
    },
    analyticsCtxFrom(c),
  );
});
continuity.get("/handoffs/:id", requirePermission("read"), (c) =>
  forwardToDO(
    c.get("doStub"),
    `/handoffs/${encodeURIComponent(c.req.param("id"))}`,
    "GET",
    undefined,
    undefined,
    analyticsCtxFrom(c),
  ),
);
continuity.get("/reentry", requirePermission("read"), async (c) => {
  const input = ReentryRequestSchema.parse(queryValues(c.req.query()));
  const identity = identityPayload(c);
  const response = await forwardToDO(
    c.get("doStub"),
    "/reentry",
    "GET",
    undefined,
    {
      ...strings(input),
      principal_id: identity.principal_id,
      participant_id: identity.participant_id,
    },
    analyticsCtxFrom(c),
  );
  if (!response.ok) return response;
  const { replay, ...state } = (await response.json()) as ReentrySnapshot;
  const changes = await completeReplay(
    replay,
    createR2JournalArchiveReader(c.env.ARTIFACTS, c.get("projectId")),
  );
  return c.json({ ok: true, ...state, changes });
});
