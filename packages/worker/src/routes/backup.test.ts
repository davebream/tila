import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { Env, HonoVariables } from "../types";
import { createBackupRoutes } from "./backup";

type AppEnv = { Bindings: Env; Variables: HonoVariables };

function harness(initialState: Record<string, unknown> | null = null) {
  let state = initialState;
  const forwarded: Array<{ path: string; body?: Record<string, unknown> }> = [];
  const stub = {
    async fetch(request: Request) {
      const path = new URL(request.url).pathname;
      const body =
        request.method === "POST"
          ? ((await request.json()) as Record<string, unknown>)
          : undefined;
      forwarded.push({ path, body });
      if (path === "/admin/transfer/status") {
        return Response.json({ state });
      }
      if (path === "/admin/transfer/begin") {
        state = {
          ...body,
          session_id: body?.sessionId,
          mode: body?.mode,
          owner: body?.owner,
        };
        return Response.json({ state });
      }
      return Response.json({ ok: true });
    },
  };
  const sql = vi.fn((_statement: string) => ({
    bind: () => ({ all: async () => ({ results: [] }) }),
  }));
  const app = new Hono<AppEnv>();
  app.use("/*", async (c, next) => {
    c.set("projectId", "demo");
    c.set("doStub", stub as unknown as DurableObjectStub);
    await next();
  });
  app.route("/", createBackupRoutes({ projectTokenAuth: false }));
  const env = {
    DB: { prepare: sql },
  } as unknown as Env;
  return { app, env, forwarded, sql };
}

describe("backup operator routes", () => {
  it("binds sessions to the authenticated infra owner", async () => {
    const { app, env, forwarded } = harness();
    const response = await app.request(
      "/transfer/begin",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Confirm-Slug": "demo",
        },
        body: JSON.stringify({
          sessionId: "session-1",
          mode: "import",
          owner: "attacker-controlled",
        }),
      },
      env,
    );
    expect(response.status).toBe(200);
    expect(forwarded.at(-1)?.body?.owner).toBe("infra");
  });

  it("rejects transfer mutation by a different session owner", async () => {
    const { app, env, forwarded } = harness({
      session_id: "session-1",
      mode: "import",
      owner: "token:someone-else",
    });
    const response = await app.request(
      "/transfer/prepare",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Confirm-Slug": "demo",
        },
        body: JSON.stringify({ sessionId: "session-1" }),
      },
      env,
    );
    expect(response.status).toBe(409);
    expect(forwarded.map(({ path }) => path)).toEqual([
      "/admin/transfer/status",
    ]);
  });

  it("requires typed slug confirmation for every import mutation", async () => {
    const { app, env, forwarded } = harness({
      session_id: "session-1",
      mode: "import",
      owner: "infra",
    });
    const response = await app.request(
      "/transfer/prepare",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: "session-1" }),
      },
      env,
    );
    expect(response.status).toBe(400);
    expect(forwarded.map(({ path }) => path)).toEqual([
      "/admin/transfer/status",
    ]);
  });

  it("exports only explicitly allowlisted D1 columns", async () => {
    const { app, env, sql } = harness({
      session_id: "session-1",
      mode: "export",
      owner: "infra",
    });
    const response = await app.request(
      "/d1?sessionId=session-1",
      undefined,
      env,
    );
    expect(response.status).toBe(200);
    expect(sql).toHaveBeenCalledTimes(5);
    for (const [statement] of sql.mock.calls) {
      expect(statement).not.toContain("SELECT *");
      expect(statement).not.toContain("token_hash");
      expect(statement).not.toContain("session_hash");
    }
    const repoExport = sql.mock.calls.find(([statement]) =>
      statement.includes("FROM _project_repos"),
    )?.[0];
    expect(repoExport).toContain("oidc_enabled");
    expect(repoExport).toContain("oidc_max_permission");
    expect(repoExport).toContain("oidc_subject_pattern");
    expect(repoExport).toContain("oidc_allowed_events");
    expect(repoExport).toContain("oidc_allowed_refs");
    expect(repoExport).toContain("oidc_allowed_environments");
    expect(repoExport).toContain("oidc_allowed_workflows");
  });
});
