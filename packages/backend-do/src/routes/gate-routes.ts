import { type RequestOrigin, gateOps } from "@tila/ops-sqlite";
import { Hono } from "hono";
import { originFromBody } from "./origin";
import type { ProjectSubRouter, RouterDeps } from "./types";

export function createGateRoutes(deps: RouterDeps): ProjectSubRouter {
  const app = new Hono();

  app.post("/gate/create", async (c) => {
    const { db } = deps;
    const body = (await c.req.json()) as {
      id: string;
      resource: string;
      await_type: string;
      fence: number;
      timeout_at?: number;
      data?: Record<string, unknown>;
      actor: string;
      actor_token_id?: string | null;
      source?: string | null;
      source_version?: string | null;
    };
    const createOrigin = originFromBody(body as Record<string, unknown>);
    const gate = gateOps.createGate(
      db,
      {
        id: body.id,
        resource: body.resource,
        await_type: body.await_type,
        fence: body.fence,
        timeout_at: body.timeout_at,
        data: body.data,
      },
      createOrigin,
    );
    return c.json({ ok: true, gate }, 201);
  });

  app.post("/gate/:gateId/resolve", async (c) => {
    const { db } = deps;
    const gateId = c.req.param("gateId");
    const body = (await c.req.json()) as {
      resolution?: string;
      actor: string;
      actor_token_id?: string | null;
      source?: string | null;
      source_version?: string | null;
    };
    const resolveOrigin = originFromBody(body as Record<string, unknown>);
    gateOps.resolveGate(db, gateId, body.resolution, resolveOrigin);
    return c.json({ ok: true });
  });

  app.delete("/gate/:gateId", async (c) => {
    const { db } = deps;
    const gateId = c.req.param("gateId");
    const body = (await c.req.json()) as {
      actor: string;
      actor_token_id?: string | null;
      source?: string | null;
      source_version?: string | null;
    };
    const cancelOrigin = originFromBody(body as Record<string, unknown>);
    gateOps.cancelGate(db, gateId, cancelOrigin);
    return c.json({ ok: true });
  });

  app.get("/gate", (c) => {
    const { db } = deps;
    const resource = c.req.query("resource") ?? undefined;
    const status = c.req.query("status") ?? undefined;
    const limitParam = c.req.query("limit");
    const limit = limitParam ? Number(limitParam) : undefined;
    const gates = gateOps.listGates(db, { resource, status, limit });
    return c.json({ ok: true, gates });
  });

  return app;
}
