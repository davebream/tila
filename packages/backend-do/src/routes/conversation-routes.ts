import { agentBindingOps, conversationOps as ops } from "@tila/ops-sqlite";
import {
  AckDeliverySchema,
  AgentIdSchema,
  CreateRoomSchema,
  CreateThreadSchema,
  DispatchReportSchema,
  PublishMessageSchema,
  RoomMemberSchema,
  RuntimeIdentitySchema,
  SetRoomMemberSchema,
} from "@tila/schemas";
import { Hono } from "hono";
import { z } from "zod";
import {
  readConversationCursor,
  signConversationCursor,
} from "./conversation-cursor";
import { jsonError } from "./responses";
import type { RouterDeps } from "./types";
const Authority = z
  .object({
    principal_id: z.string().min(1),
    participant_id: z.string().min(1),
    can_manage: z.boolean(),
    runtime: RuntimeIdentitySchema.nullable(),
  })
  .strict();
type Env = {
  Variables: { authority: z.infer<typeof Authority>; cursorKey: string };
};
export function createConversationRoutes(deps: RouterDeps) {
  const app = new Hono<Env>();
  const waiters = new Map<string, Set<() => void>>();
  const notify = (agent?: string) => {
    for (const [id, list] of waiters)
      if (!agent || agent === id) for (const wake of [...list]) wake();
  };
  for (const path of ["/rooms/*", "/inbox/*", "/dispatch/*"])
    app.use(path, async (c, next) => {
      const a = Authority.safeParse(
        JSON.parse(c.req.header("X-Tila-Conversation-Authority") ?? "null"),
      );
      const secret = c.req.header("X-Tila-Conversation-Cursor-Key");
      if (!a.success || !secret)
        return jsonError(
          c,
          403,
          "permission-denied",
          "Worker authority required",
        );
      c.set("authority", a.data);
      c.set("cursorKey", secret);
      c.header("Cache-Control", "private, no-store");
      await next();
    });
  app.onError((error, c) => {
    if (
      error instanceof ops.ConversationError ||
      error instanceof agentBindingOps.AgentBindingError
    )
      return jsonError(c, error.status, error.code, error.message, {
        reason: error.code.toUpperCase().replace(/-/g, "_"),
      });
    if (error instanceof z.ZodError || error instanceof SyntaxError) {
      const tooLarge =
        error instanceof z.ZodError &&
        error.issues.some((i) => i.message === "body-too-large");
      if (tooLarge)
        return jsonError(
          c,
          400,
          "body-too-large",
          "Inline bodies are limited to 64 KB; use artifact references",
          { reason: "BODY_TOO_LARGE" },
        );
      return jsonError(
        c,
        400,
        "validation-error",
        "Invalid conversation request",
      );
    }
    throw error;
  });
  app.get("/rooms", (c) =>
    c.json({ ok: true, rooms: ops.listRooms(deps.db, c.get("authority")) }),
  );
  app.post("/rooms", async (c) =>
    c.json({
      ok: true,
      room: ops.createRoom(
        deps.db,
        CreateRoomSchema.parse(await c.req.json()),
        c.get("authority"),
      ),
    }),
  );
  app.get("/rooms/:room", (c) =>
    c.json({
      ok: true,
      ...ops.getRoom(
        deps.db,
        AgentIdSchema.parse(c.req.param("room")),
        c.get("authority"),
      ),
    }),
  );
  app.put("/rooms/:room/members/:member", async (c) => {
    const member = RoomMemberSchema.shape.member.parse(c.req.param("member"));
    ops.setMember(
      deps.db,
      AgentIdSchema.parse(c.req.param("room")),
      member,
      SetRoomMemberSchema.parse(await c.req.json()).wake,
      c.get("authority"),
    );
    return c.json({ ok: true });
  });
  app.delete("/rooms/:room/members/:member", (c) => {
    ops.setMember(
      deps.db,
      AgentIdSchema.parse(c.req.param("room")),
      RoomMemberSchema.shape.member.parse(c.req.param("member")),
      null,
      c.get("authority"),
    );
    return c.json({ ok: true });
  });
  app.get("/rooms/:room/threads", (c) =>
    c.json({
      ok: true,
      threads: ops.listThreads(
        deps.db,
        c.req.param("room"),
        c.get("authority"),
      ),
    }),
  );
  app.post("/rooms/:room/threads", async (c) =>
    c.json({
      ok: true,
      thread: ops.createThread(
        deps.db,
        c.req.param("room"),
        CreateThreadSchema.parse(await c.req.json()),
        c.get("authority"),
      ),
    }),
  );
  app.post("/rooms/:room/messages", async (c) => {
    const result = await ops.publish(
      deps.db,
      c.req.param("room"),
      PublishMessageSchema.parse(await c.req.json()),
      c.get("authority"),
    );
    notify();
    return c.json({ ok: true, ...result });
  });
  app.get("/rooms/:room/messages", async (c) => {
    const a = c.get("authority");
    const room = c.req.param("room");
    const thread = c.req.query("thread_id");
    const direction = z
      .enum(["forward", "backward"])
      .parse(c.req.query("direction") ?? "forward");
    const scopeParts = [
      "history",
      room,
      thread ?? null,
      a.principal_id,
      a.participant_id,
      a.runtime?.agent_id ?? null,
    ];
    const scope = JSON.stringify(
      direction === "forward" ? scopeParts : [...scopeParts, "backward"],
    );
    const generation = ops.cursorGeneration(deps.db);
    const cursor = c.req.query("cursor");
    const after = cursor
      ? z
          .number()
          .int()
          .nonnegative()
          .parse(
            await readConversationCursor(
              c.get("cursorKey"),
              cursor,
              scope,
              generation,
            ),
          )
      : 0;
    if (generation !== ops.cursorGeneration(deps.db))
      throw new ops.ConversationError(
        "cursor-expired",
        "Project restored during pagination",
        410,
      );
    const limit = z.coerce
      .number()
      .int()
      .min(1)
      .max(100)
      .parse(c.req.query("limit") ?? 50);
    const result = ops.history(
      deps.db,
      room,
      a,
      after,
      limit,
      thread,
      direction,
    );
    const tail =
      result.messages.at(-1)?.seq ?? (direction === "backward" ? 0 : after);
    const boundary =
      direction === "backward" ? (result.messages[0]?.seq ?? after) : tail;
    return c.json({
      ok: true,
      ...result,
      cursor: await signConversationCursor(
        c.get("cursorKey"),
        scope,
        generation,
        boundary,
      ),
      tail_cursor: await signConversationCursor(
        c.get("cursorKey"),
        JSON.stringify(scopeParts),
        generation,
        tail,
      ),
    });
  });
  app.get("/inbox/:agent", async (c) => {
    const agent = AgentIdSchema.parse(c.req.param("agent"));
    const a = c.get("authority");
    const version = ops.inboxVersion(deps.db, agent, a);
    const generation = ops.cursorGeneration(deps.db);
    const scope = JSON.stringify([
      "inbox",
      agent,
      a.principal_id,
      a.runtime?.run_id,
      version.version.split(":")[1],
    ]);
    let after: { ordinal: number; id: string } | undefined;
    let cursorError: string | null = null;
    if (c.req.query("cursor"))
      try {
        after = z
          .object({
            ordinal: z.number().int().positive(),
            id: z.string().uuid(),
          })
          .parse(
            await readConversationCursor(
              c.get("cursorKey"),
              c.req.query("cursor") ?? "",
              scope,
              generation,
            ),
          );
      } catch (error) {
        if (
          error instanceof ops.ConversationError &&
          error.code === "cursor-expired"
        )
          cursorError = error.code;
        else throw error;
      }
    const result = ops.fetchInbox(
      deps.db,
      agent,
      a,
      z.coerce
        .number()
        .int()
        .min(1)
        .max(100)
        .parse(c.req.query("limit") ?? 50),
      after,
    );
    const last = result.deliveries.at(-1)?.delivery;
    return c.json({
      ok: true,
      ...result,
      cursor_error: cursorError,
      cursor:
        result.has_more && last
          ? await signConversationCursor(
              c.get("cursorKey"),
              scope,
              generation,
              { ordinal: last.ordinal, id: last.id },
            )
          : null,
    });
  });
  app.get("/inbox/:agent/watch", async (c) => {
    const agent = AgentIdSchema.parse(c.req.param("agent"));
    const a = c.get("authority");
    const expected = c.req.query("version");
    const initial = ops.inboxVersion(deps.db, agent, a);
    if (!expected || expected !== initial.version)
      return c.json({ ok: true, changed: true, ...initial });
    const list = waiters.get(agent) ?? new Set<() => void>();
    if (list.size >= 2)
      throw new ops.ConversationError(
        "rate-limited",
        "At most two watches per agent",
        429,
      );
    const requestedDuration = z.coerce
      .number()
      .int()
      .min(0)
      .max(25000)
      .parse(c.req.query("timeout_ms") ?? 25000);
    // Return before the authenticated lease hint expires; the Worker rechecks
    // D1 after the wait and the next poll obtains a fresh renewed identity.
    const duration = Math.min(
      requestedDuration,
      Math.max(
        0,
        (a.runtime?.lease_expires_at ?? 0) * 1000 - Date.now() - 1000,
      ),
    );
    // No await between checking the cursor and registering the waiter.
    await new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        list.delete(finish);
        if (!list.size) waiters.delete(agent);
        resolve();
      };
      const timer = setTimeout(finish, duration);
      list.add(finish);
      waiters.set(agent, list);
    });
    const latest = ops.inboxVersion(deps.db, agent, a);
    return c.json({
      ok: true,
      changed: latest.version !== initial.version,
      ...latest,
    });
  });
  app.post("/inbox/:agent/deliveries/:id/ack", async (c) => {
    const result = ops.acknowledge(
      deps.db,
      c.req.param("agent"),
      c.req.param("id"),
      AckDeliverySchema.parse(await c.req.json()),
      c.get("authority"),
    );
    notify(c.req.param("agent"));
    return c.json({ ok: true, ...result });
  });
  app.get("/inbox/:agent/deliveries/:id", (c) =>
    c.json({
      ok: true,
      ...ops.explainDelivery(
        deps.db,
        c.req.param("agent"),
        c.req.param("id"),
        c.get("authority"),
      ),
    }),
  );
  app.post("/inbox/:agent/deliveries/:id/resume", (c) => {
    ops.resumeDelivery(
      deps.db,
      c.req.param("agent"),
      c.req.param("id"),
      c.get("authority"),
    );
    return c.json({ ok: true });
  });
  app.get("/dispatch/:agent/status", (c) =>
    c.json({
      ok: true,
      ...ops.dispatchStatus(
        deps.db,
        c.req.param("agent"),
        c.get("authority"),
        Date.now(),
        z.string().uuid().optional().parse(c.req.query("lease_token")),
      ),
    }),
  );
  app.post("/dispatch/:agent/lease", (c) =>
    c.json({
      ok: true,
      lease: ops.leaseDispatch(
        deps.db,
        c.req.param("agent"),
        c.get("authority"),
      ),
    }),
  );
  app.post("/dispatch/:agent/report", async (c) =>
    c.json({
      ok: true,
      ...ops.reportDispatch(
        deps.db,
        c.req.param("agent"),
        DispatchReportSchema.parse(await c.req.json()),
        c.get("authority"),
      ),
    }),
  );
  return app;
}
