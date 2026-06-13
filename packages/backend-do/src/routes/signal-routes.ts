import { signalOps } from "@tila/ops-sqlite";
import { SendSignalRequestSchema } from "@tila/schemas";
import { Hono } from "hono";
import { formatZodIssues, jsonError } from "./responses";
import type { ProjectSubRouter, RouterDeps } from "./types";

export function createSignalRoutes(deps: RouterDeps): ProjectSubRouter {
  const app = new Hono();

  app.post("/signal/send", async (c) => {
    const { db } = deps;
    const raw = await c.req.json();
    const parsed = SendSignalRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return jsonError(
        c,
        400,
        "validation-error",
        formatZodIssues(parsed.error.issues),
      );
    }
    const result = signalOps.send(db, {
      ...parsed.data,
      created_by: raw.created_by as string,
    });
    return c.json({ ok: true, id: result.id });
  });

  app.get("/signal/inbox", (c) => {
    const { db } = deps;
    const target = c.req.query("target");
    if (!target) {
      return jsonError(
        c,
        400,
        "validation-error",
        "target query param required",
      );
    }
    const signals = signalOps.inbox(db, target);
    return c.json({ ok: true, signals });
  });

  app.post("/signal/:id/ack", async (c) => {
    const { db } = deps;
    const signalId = c.req.param("id");
    const raw = await c.req.json().catch(() => ({}));
    const acker = (raw as { acker?: unknown }).acker;
    if (typeof acker !== "string" || acker.length === 0) {
      return jsonError(c, 400, "validation-error", "acker required");
    }
    const result = signalOps.ack(db, signalId, acker);
    if (!result.found) {
      return jsonError(c, 404, "not-found", "Signal not found");
    }
    if (!result.authorized) {
      return jsonError(
        c,
        403,
        "forbidden",
        "Only the signal's addressee or sender may acknowledge it",
      );
    }
    return c.json({ ok: true });
  });

  return app;
}
