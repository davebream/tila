import { journalArchiveOps, journalOps } from "@tila/ops-sqlite";
import { Hono } from "hono";
import type { ProjectSubRouter, RouterDeps } from "./types";

const MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000; // 90 days
const MAX_ROWS = 500_000;

export function createJournalArchiveRoutes(deps: RouterDeps): ProjectSubRouter {
  const app = new Hono();

  // POST /journal/archive — return archivable events for Worker to write to R2
  app.post("/journal/archive", (c) => {
    const result = journalArchiveOps.getArchivableEvents(deps.db, {
      maxAgeMs: MAX_AGE_MS,
      maxRows: MAX_ROWS,
    });

    return c.json({
      ok: true,
      events: result.events,
      throughSeq: result.throughSeq,
      count: result.events.length,
    });
  });

  // POST /journal/archive/confirm — confirm R2 write; watermark advances + rows deleted
  app.post("/journal/archive/confirm", async (c) => {
    const body = (await c.req.json()) as { throughSeq?: number };
    const throughSeq = body.throughSeq;

    if (typeof throughSeq !== "number") {
      return c.json(
        {
          ok: false,
          error: { code: "BAD_REQUEST", message: "throughSeq is required" },
        },
        400,
      );
    }

    journalArchiveOps.markArchived(deps.db, throughSeq);
    const watermark = journalArchiveOps.getArchiveWatermark(deps.db);

    return c.json({ ok: true, watermark });
  });

  // GET /journal/archive/status — return watermark + current journal stats
  app.get("/journal/archive/status", (c) => {
    const watermark = journalArchiveOps.getArchiveWatermark(deps.db);
    const stats = journalOps.journalStats(deps.db);

    return c.json({ ok: true, watermark, journalStats: stats });
  });

  return app;
}
