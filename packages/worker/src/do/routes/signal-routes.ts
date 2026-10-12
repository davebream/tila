import { signalOps } from "@tila/ops-sqlite";
import {
  SendSignalRequestSchema,
  SetSignalGroupRequestSchema,
  SignalGroupIdSchema,
  SignalIdentitySchema,
} from "@tila/schemas";
import { Hono } from "hono";
import { formatZodIssues, jsonError } from "./responses";
import type { ProjectSubRouter, RouterDeps } from "./types";

export function createSignalRoutes(deps: RouterDeps): ProjectSubRouter {
  const app = new Hono();

  app.post("/signal/send", async (c) => {
    const raw = (await c.req.json()) as Record<string, unknown>;
    const parsed = SendSignalRequestSchema.safeParse(raw);
    const sender = SignalIdentitySchema.safeParse(raw.sender);
    if (!parsed.success) {
      return jsonError(
        c,
        400,
        "validation-error",
        formatZodIssues(parsed.error.issues),
      );
    }
    if (!sender.success) {
      return jsonError(
        c,
        400,
        "validation-error",
        formatZodIssues(sender.error.issues),
      );
    }
    try {
      const result = signalOps.send(deps.db, {
        ...parsed.data,
        sender: sender.data,
      });
      return c.json({ ok: true, ...result });
    } catch (error) {
      if (error instanceof signalOps.SignalGroupNotFoundError) {
        return jsonError(
          c,
          404,
          "signal-group-not-found",
          "Signal group not found",
        );
      }
      if (error instanceof signalOps.NoActiveRecipientsError) {
        return jsonError(
          c,
          409,
          "no-active-recipients",
          "Signal target has no active recipients",
        );
      }
      throw error;
    }
  });

  app.get("/signal/inbox", (c) => {
    const principal_id = c.req.query("principal_id");
    const participant_id = c.req.query("participant_id");
    const identity = SignalIdentitySchema.pick({
      principal_id: true,
      participant_id: true,
    }).safeParse({ principal_id, participant_id });
    if (!identity.success) {
      return jsonError(
        c,
        400,
        "participant-required",
        "Canonical principal and participant are required",
      );
    }
    return c.json({
      ok: true,
      signals: signalOps.inbox(deps.db, identity.data),
    });
  });

  app.get("/signal/history", (c) => {
    const rawLimit = c.req.query("limit");
    const limit = rawLimit === undefined ? undefined : Number(rawLimit);
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
      return jsonError(c, 400, "validation-error", "limit must be positive");
    }
    return c.json({
      ok: true,
      ...signalOps.history(deps.db, {
        limit,
        cursor: c.req.query("cursor"),
      }),
    });
  });

  app.get("/signal/groups", (c) =>
    c.json({ ok: true, groups: signalOps.listGroups(deps.db) }),
  );

  app.get("/signal/groups/:groupId", (c) => {
    const groupId = SignalGroupIdSchema.safeParse(c.req.param("groupId"));
    if (!groupId.success)
      return jsonError(c, 400, "validation-error", "Invalid signal group ID");
    const group = signalOps.getGroup(deps.db, groupId.data);
    return group
      ? c.json({ ok: true, group })
      : jsonError(c, 404, "signal-group-not-found", "Signal group not found");
  });

  app.put("/signal/groups/:groupId", async (c) => {
    const groupId = SignalGroupIdSchema.safeParse(c.req.param("groupId"));
    const raw = (await c.req.json()) as Record<string, unknown>;
    const input = SetSignalGroupRequestSchema.safeParse(raw);
    const actor = SignalIdentitySchema.safeParse(raw.actor);
    if (!groupId.success || !input.success || !actor.success) {
      return jsonError(c, 400, "validation-error", "Invalid signal group");
    }
    return c.json({
      ok: true,
      group: signalOps.setGroup(
        deps.db,
        groupId.data,
        input.data.name,
        input.data.principal_ids,
        actor.data,
      ),
    });
  });

  app.delete("/signal/groups/:groupId", (c) => {
    const groupId = SignalGroupIdSchema.safeParse(c.req.param("groupId"));
    if (!groupId.success)
      return jsonError(c, 400, "validation-error", "Invalid signal group ID");
    if (!signalOps.deleteGroup(deps.db, groupId.data)) {
      return jsonError(
        c,
        404,
        "signal-group-not-found",
        "Signal group not found",
      );
    }
    return c.json({ ok: true });
  });

  app.post("/signal/:id/ack", async (c) => {
    const acknowledger = SignalIdentitySchema.safeParse(
      await c.req.json().catch(() => ({})),
    );
    if (!acknowledger.success) {
      return jsonError(c, 400, "participant-required", "Acknowledger required");
    }
    const result = signalOps.ack(deps.db, c.req.param("id"), acknowledger.data);
    if (!result.found)
      return jsonError(c, 404, "not-found", "Signal not found");
    if (result.expired)
      return jsonError(c, 410, "signal-expired", "Signal has expired");
    if (!result.authorized) {
      return jsonError(
        c,
        403,
        "forbidden",
        "Only this signal delivery's participant may acknowledge it",
      );
    }
    return c.json({ ok: true });
  });

  return app;
}
