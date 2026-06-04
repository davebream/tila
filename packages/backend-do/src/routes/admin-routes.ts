import { artifactOps, storeCountsOps } from "@tila/ops-sqlite";
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
      // Empty every domain table explicitly. We must NOT call ctx.storage.deleteAll():
      // on a SQLite-backed DO it drops the SQL tables, which leaves the schema broken
      // (migrations think they have already run) and corrupts the object. Deleting rows
      // keeps the schema intact. defer_foreign_keys allows any delete order within the
      // implicit transaction; deleting the *_search_docs base tables fires the FTS5
      // cleanup triggers.
      const rawSql = deps.ctx.storage.sql;
      rawSql.exec("PRAGMA defer_foreign_keys = ON");
      for (const table of storeCountsOps.DOMAIN_TABLE_NAMES) {
        rawSql.exec(`DELETE FROM "${table}"`);
      }
      rawSql.exec("DELETE FROM _schema_history");
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
