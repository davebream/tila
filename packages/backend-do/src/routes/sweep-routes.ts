import { artifactOps, sweepOps } from "@tila/ops-sqlite";
import { Hono } from "hono";
import type { ProjectSubRouter, RouterDeps } from "./types";

export function createSweepRoutes(deps: RouterDeps): ProjectSubRouter {
  const app = new Hono();

  app.post("/sweep", async (c) => {
    const { db } = deps;
    const body = (await c.req.json().catch(() => ({}))) as {
      batch_size?: number;
    };
    const batchSize = Math.min(Math.max(body.batch_size ?? 100, 1), 500);

    const result = sweepOps.sweep(db);
    const expiredPointers = artifactOps.listExpiredPointers(
      db,
      Date.now(),
      batchSize,
    );
    const expiredKeys = expiredPointers.map((p) => p.r2_key);

    return c.json({
      ok: true,
      ...result,
      expiredKeys,
    });
  });

  return app;
}
