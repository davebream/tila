import { describe, expect, it, vi } from "vitest";
import { createAdminRoutes } from "../src/routes/admin-routes";
import { createDiagnosticRoutes } from "../src/routes/diagnostic-routes";
import type { RouterDeps } from "../src/routes/types";

function makeDeps(ctx: unknown): RouterDeps {
  return {
    ctx: ctx as DurableObjectState,
    db: {} as RouterDeps["db"],
    enrichOpts: vi.fn() as RouterDeps["enrichOpts"],
  };
}

describe("admin routes", () => {
  it("calls ctx.abort on restart", async () => {
    const abort = vi.fn();
    const app = createAdminRoutes(makeDeps({ abort }));

    const res = await app.request("/admin/restart", { method: "POST" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(abort).toHaveBeenCalledWith("admin restart requested");
  });
});

describe("diagnostic routes", () => {
  it("returns schema metadata for critical tables", async () => {
    const exec = vi.fn((statement: string) => {
      if (statement.includes("FROM _migrations")) {
        return { toArray: () => [{ version: 1, applied_at: 123 }] };
      }
      if (statement.includes("sqlite_master")) {
        return { toArray: () => [{ name: "claims" }, { name: "journal" }] };
      }
      if (statement.includes("sqlite_version")) {
        return { toArray: () => [{ version: "3.47.0" }] };
      }
      if (statement.includes("PRAGMA table_info(claims)")) {
        return {
          toArray: () => [
            {
              cid: 0,
              name: "resource",
              type: "TEXT",
              notnull: 0,
              dflt_value: null,
              pk: 1,
            },
          ],
        };
      }
      return { toArray: () => [] };
    });
    const app = createDiagnosticRoutes(
      makeDeps({ storage: { sql: { exec } } }),
    );

    const res = await app.request("/doctor/schema");

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      sqlite_version: string;
      migrations: Array<{ version: number }>;
      tables: string[];
      columns: Record<string, Array<{ name: string }>>;
      claims_columns: Array<{ name: string }>;
    };
    expect(body.ok).toBe(true);
    expect(body.sqlite_version).toBe("3.47.0");
    expect(body.migrations).toEqual([{ version: 1, applied_at: 123 }]);
    expect(body.tables).toEqual(["claims", "journal"]);
    expect(body.columns.claims[0]?.name).toBe("resource");
    expect(body.claims_columns[0]?.name).toBe("resource");
  });
});
