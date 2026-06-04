import { Hono } from "hono";
import { DO_CODE_VERSION } from "../version";
import type { ProjectSubRouter, RouterDeps } from "./types";

const DIAGNOSTIC_TABLES = [
  "claims",
  "journal",
  "_schema_history",
  "artifact_search_docs",
  "entity_search_docs",
  "gates",
  "signals",
  "records",
] as const;

type SqliteColumnInfo = {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
};

export function createDiagnosticRoutes(deps: RouterDeps): ProjectSubRouter {
  const app = new Hono();

  app.get("/doctor/schema", (c) => {
    const { ctx } = deps;

    try {
      const migrations = ctx.storage.sql
        .exec<{ version: number; applied_at: number }>(
          "SELECT version, applied_at FROM _migrations ORDER BY version",
        )
        .toArray();

      const columns: Record<string, SqliteColumnInfo[]> = {};
      for (const table of DIAGNOSTIC_TABLES) {
        try {
          columns[table] = ctx.storage.sql
            .exec<SqliteColumnInfo>(`PRAGMA table_info(${table})`)
            .toArray();
        } catch {
          columns[table] = [];
        }
      }

      const tables = ctx.storage.sql
        .exec<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
        )
        .toArray();

      let sqliteVersion: string | undefined;
      try {
        sqliteVersion = ctx.storage.sql
          .exec<{ version: string }>("SELECT sqlite_version() as version")
          .toArray()[0]?.version;
      } catch {
        sqliteVersion = "restricted";
      }

      return c.json({
        ok: true,
        do_code_version: DO_CODE_VERSION,
        sqlite_version: sqliteVersion,
        migrations,
        columns,
        claims_columns: columns.claims,
        tables: tables.map((t) => t.name),
      });
    } catch (err) {
      return c.json({
        ok: false,
        do_code_version: DO_CODE_VERSION,
        sqlite_version: null,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  return app;
}
