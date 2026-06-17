import { artifactOps, destroyOps, storeCountsOps } from "@tila/ops-sqlite";
import { Hono } from "hono";
import type { ProjectSubRouter, RouterDeps } from "./types";

export function createAdminRoutes(deps: RouterDeps): ProjectSubRouter {
  const app = new Hono();

  app.post("/admin/restart", (c) => {
    const response = c.json({ ok: true });
    deps.ctx.abort("admin restart requested");
    return response;
  });

  app.get("/admin/pointer-keys", (c) => {
    const keys = artifactOps.listAllPointerKeys(deps.db);
    return c.json({ keys });
  });

  app.get("/admin/store-counts", (c) => {
    const counts = storeCountsOps.countStoreRows(deps.db);
    return c.json({ counts });
  });

  app.post("/admin/destroy", async (c) => {
    try {
      await deps.ctx.storage.deleteAlarm();
      // Truncate every domain table (and _schema_history) via the ops module, so the
      // raw-SQL destroy lives in @tila/ops-sqlite alongside the rest of the DB layer.
      // We must NOT call ctx.storage.deleteAll(): on a SQLite-backed DO it drops the SQL
      // tables, which leaves the schema broken (migrations think they have already run)
      // and corrupts the object. Deleting rows keeps the schema intact.
      destroyOps.truncateAllDomainTables(deps.ctx.storage.sql);
    } catch (err) {
      console.error("[admin/destroy] failed to clear DO state:", err);
      return c.json({ ok: false, error: { code: "destroy-failed" } }, 500);
    }

    // IMPORTANT: return normally (do NOT ctx.abort()). abort() would roll back this
    // invocation's uncommitted SQL deletes; returning lets the output gate durably
    // commit them.
    return c.json({ ok: true });
  });

  return app;
}
