import {
  type AgentRuntimePage,
  RuntimeViewQuerySchema,
  RuntimeViewResponseSchema,
} from "@tila/schemas";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import {
  decodeRuntimeCursor,
  encodeRuntimeCursor,
  loadRuntimeView,
} from "../src/lib/runtime-view";
import type { Env, HonoVariables } from "../src/types";

const RUN = "00000000-0000-4000-8000-0000000000a1";
const ENROLLMENT = "00000000-0000-4000-8000-0000000000e1";
const lease = Math.floor(Date.now() / 1000) + 300;

const page: AgentRuntimePage = {
  rows: [
    {
      agent: { id: "worker", name: "Worker", binding_epoch: 1 },
      current: {
        binding: {
          consumer_binding_id: "00000000-0000-4000-8000-0000000000c1",
          agent_id: "worker",
          binding_epoch: 1,
          holder: {
            kind: "run",
            run_id: RUN,
            enrollment_id: ENROLLMENT,
            workload_binding_id: null,
          },
          principal_id: "enrollment:host",
          participant_id: "participant",
          host_ref: ENROLLMENT,
          harness: "cli",
          native_session_ref: null,
          profile: null,
          capability_report: {
            protocol: 1,
            adapter_version: "1",
            capabilities: {},
          },
          mechanism: "poll",
          attended: true,
          allow_idle_start: false,
          state: "active",
          lease_expires_at: lease,
          created_at: 1,
          updated_at: 1,
        },
        detail: "full",
        presence: null,
        release_authorized: true,
      },
      previous: null,
    },
  ],
  next_after: "worker",
};

function app(
  doResponse: () => Response,
  store: Parameters<typeof loadRuntimeView>[2],
) {
  const fetch = vi.fn(async (_request: Request) => doResponse());
  const server = new Hono<{ Bindings: Env; Variables: HonoVariables }>();
  server.use("*", async (c, next) => {
    c.set("projectId", "project");
    c.set("doStub", { fetch } as unknown as DurableObjectStub);
    c.set("tokenResult", {
      kind: "d1-token",
      projectId: "project",
      name: "owner",
      scopes: "full",
      tokenId: "token",
    } as HonoVariables["tokenResult"]);
    c.set("effectiveRole", "owner");
    await next();
  });
  server.get("/", (c) =>
    loadRuntimeView(c, RuntimeViewQuerySchema.parse(c.req.query()), store),
  );
  return { server, fetch };
}

const healthyStore = {
  runsByIds: async () => [
    {
      run_id: RUN,
      run_role: "acting" as const,
      enrollment_id: ENROLLMENT,
      workload_binding_id: null,
      principal_id: "enrollment:host",
      participant_id: "participant",
      state: "active",
      lease_expires_at: lease,
      created_at: 1,
    },
  ],
  enrollmentsByIds: async () => [
    {
      enrollment_id: ENROLLMENT,
      installation_id: "00000000-0000-4000-8000-0000000000f1",
      name: "host",
      kind: "personal" as const,
      sponsor_id: null,
      created_at: 1,
      revoked_at: null,
    },
  ],
};

describe("loadRuntimeView", () => {
  it("joins the DO page with D1 and returns an opaque cursor", async () => {
    const { server, fetch } = app(
      () => Response.json({ ok: true, ...page }),
      healthyStore,
    );
    const response = await server.request("/?limit=1");
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    const body = RuntimeViewResponseSchema.parse(await response.json());
    expect(body.rows[0].current?.observation.lifecycle).toBe("attached");
    expect(body.next_cursor).not.toBeNull();
    expect(decodeRuntimeCursor(body.next_cursor as string)).toBe("worker");
    const forwarded = fetch.mock.calls[0][0];
    expect(new URL(forwarded.url).pathname).toBe(
      "/agents/internal/runtime-page",
    );
    expect(
      JSON.parse(forwarded.headers.get("X-Tila-Agent-Authority") ?? "{}"),
    ).toMatchObject({ can_manage: true, runtime: null });
  });

  it("reports D1 failures per source instead of failing or emptying the view", async () => {
    const { server } = app(() => Response.json({ ok: true, ...page }), {
      runsByIds: async () => {
        throw new Error("D1 unavailable");
      },
      enrollmentsByIds: healthyStore.enrollmentsByIds,
    });
    const body = RuntimeViewResponseSchema.parse(
      await (await server.request("/")).json(),
    );
    expect(body.sources).toMatchObject({
      runs: "unavailable",
      enrollments: "ok",
    });
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0].current).toMatchObject({
      run: { status: "unknown", reason: "source-unavailable" },
      observation: {
        lifecycle: "unknown",
        reasons: ["run-source-unavailable"],
      },
    });
  });

  it("passes a DO failure through instead of returning an empty list", async () => {
    const { server } = app(
      () =>
        Response.json(
          {
            ok: false,
            error: { code: "do-unreachable", message: "x", retryable: true },
          },
          { status: 503 },
        ),
      healthyStore,
    );
    const response = await server.request("/");
    expect(response.status).toBe(503);
  });

  it("round-trips cursors and rejects malformed ones", () => {
    expect(decodeRuntimeCursor(encodeRuntimeCursor("agent.one_2"))).toBe(
      "agent.one_2",
    );
    for (const bad of ["not-a-cursor", encodeRuntimeCursor("")])
      expect(() => decodeRuntimeCursor(bad)).toThrow(/cursor/);
  });
});
