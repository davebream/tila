import { runtimeAttention } from "@tila/core";
import {
  type AgentRuntimePage,
  RUNTIME_ATTENTION_SCAN_LIMIT,
  RUNTIME_VIEW_MAX_LIMIT,
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
  doResponse: (request: Request) => Response,
  store: Parameters<typeof loadRuntimeView>[2],
) {
  const fetch = vi.fn(async (request: Request) => doResponse(request));
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

describe("loadRuntimeView with the attention filter", () => {
  const RUN_EXPIRED = "00000000-0000-4000-8000-0000000000a2";
  type PageRow = AgentRuntimePage["rows"][number];
  type Kind = "healthy" | "expired" | "epoch-mismatch";
  const occupant = page.rows[0].current as NonNullable<PageRow["current"]>;

  /** An agent whose occupant is healthy, has a lapsed run, or a stale epoch. */
  function agentRow(id: string, kind: Kind): PageRow {
    return {
      agent: {
        id,
        name: id,
        binding_epoch: kind === "epoch-mismatch" ? 2 : 1,
      },
      current: {
        ...occupant,
        binding: {
          ...occupant.binding,
          consumer_binding_id: crypto.randomUUID(),
          agent_id: id,
          holder: {
            ...occupant.binding.holder,
            run_id: kind === "expired" ? RUN_EXPIRED : RUN,
          },
        },
      },
      previous: null,
    };
  }

  const agentId = (index: number) => `agent-${String(index).padStart(3, "0")}`;

  /** A DO that pages `count` agents by id, honouring `after` and `limit`. */
  function directory(count: number, problems: Record<number, Kind> = {}) {
    const rows = Array.from({ length: count }, (_, i) =>
      agentRow(agentId(i), problems[i] ?? "healthy"),
    );
    return (request: Request) => {
      const params = new URL(request.url).searchParams;
      const after = params.get("after");
      const limit = Number(params.get("limit"));
      const start = after ? rows.findIndex((row) => row.agent.id > after) : 0;
      const slice = start < 0 ? [] : rows.slice(start, start + limit);
      const more = start >= 0 && start + limit < rows.length;
      return Response.json({
        ok: true,
        rows: slice,
        next_after: more ? (slice.at(-1)?.agent.id ?? null) : null,
      });
    };
  }

  const runRecord = (run_id: string, lease_expires_at: number) => ({
    run_id,
    run_role: "acting" as const,
    enrollment_id: ENROLLMENT,
    workload_binding_id: null,
    principal_id: "enrollment:host",
    participant_id: "participant",
    state: "active",
    lease_expires_at,
    created_at: 1,
  });
  const store = {
    runsByIds: async () => [
      runRecord(RUN, lease),
      runRecord(RUN_EXPIRED, Math.floor(Date.now() / 1000) - 60),
    ],
    enrollmentsByIds: healthyStore.enrollmentsByIds,
  };

  const forwarded = (fetch: ReturnType<typeof app>["fetch"]) =>
    fetch.mock.calls.map(([request]) => {
      const params = new URL(request.url).searchParams;
      return { after: params.get("after"), limit: params.get("limit") };
    });

  async function view(server: ReturnType<typeof app>["server"], query = "") {
    const response = await server.request(`/?filter=attention${query}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    return RuntimeViewResponseSchema.parse(await response.json());
  }

  it("rejects a malformed cursor before scanning", async () => {
    const { server, fetch } = app(directory(120), store);
    const response = await server.request(
      "/?filter=attention&cursor=not-a-cursor",
    );
    // This harness skips the route, which maps the cursor error to a 400.
    expect(response.ok).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("follows every DO page and keeps only rows that need attention", async () => {
    const { server, fetch } = app(
      directory(120, { 3: "expired", 49: "expired", 50: "epoch-mismatch" }),
      store,
    );
    const body = await view(server);
    expect(forwarded(fetch)).toEqual([
      { after: null, limit: String(RUNTIME_VIEW_MAX_LIMIT) },
      { after: agentId(49), limit: String(RUNTIME_VIEW_MAX_LIMIT) },
      { after: agentId(99), limit: String(RUNTIME_VIEW_MAX_LIMIT) },
    ]);
    expect(body.scan).toEqual({ agents: 120, complete: true });
    expect(body.total).toBe(3);
    expect(body.next_cursor).toBeNull();
    expect(body.sources).toEqual({
      agents: "ok",
      runs: "ok",
      enrollments: "ok",
      presence: "ok",
    });
    expect(
      body.rows.map((row) => [
        row.agent.id,
        row.current && runtimeAttention(row.current.observation),
      ]),
    ).toEqual([
      [agentId(3), "mailbox-expired"],
      [agentId(49), "mailbox-expired"],
      [agentId(50), "mailbox-unknown"],
    ]);
  });

  it("leaves total and scan out when no filter is given", async () => {
    const { server, fetch } = app(directory(120, { 3: "expired" }), store);
    const body = RuntimeViewResponseSchema.parse(
      await (await server.request("/?limit=10")).json(),
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(body.rows).toHaveLength(10);
    expect(body.total).toBeUndefined();
    expect(body.scan).toBeUndefined();
  });

  it("stops at the scan limit and reports the scan as partial", async () => {
    const { server, fetch } = app(
      directory(RUNTIME_ATTENTION_SCAN_LIMIT + 50, {
        10: "expired",
        [RUNTIME_ATTENTION_SCAN_LIMIT + 10]: "expired",
      }),
      store,
    );
    const body = await view(server);
    // ceil(250 / 50) DO pages, then the scan stops with agents left.
    expect(fetch).toHaveBeenCalledTimes(
      Math.ceil(RUNTIME_ATTENTION_SCAN_LIMIT / RUNTIME_VIEW_MAX_LIMIT),
    );
    expect(body.scan).toEqual({
      agents: RUNTIME_ATTENTION_SCAN_LIMIT,
      complete: false,
    });
    // The agent past the limit was never examined.
    expect(body.total).toBe(1);
    expect(body.rows.map((row) => row.agent.id)).toEqual([agentId(10)]);
  });

  it("reports a complete scan when the directory ends exactly at the limit", async () => {
    const { server, fetch } = app(
      directory(RUNTIME_ATTENTION_SCAN_LIMIT),
      store,
    );
    const body = await view(server);
    expect(fetch).toHaveBeenCalledTimes(5);
    expect(body.scan).toEqual({
      agents: RUNTIME_ATTENTION_SCAN_LIMIT,
      complete: true,
    });
    expect(body.total).toBe(0);
    expect(body.rows).toEqual([]);
  });

  it("reports a runs outage on any page and does not count it as attention", async () => {
    let calls = 0;
    const { server } = app(
      directory(60, {
        10: "expired",
        55: "expired",
        58: "epoch-mismatch",
      }),
      {
        runsByIds: async () => {
          calls += 1;
          // The second page's run lookup fails.
          if (calls > 1) throw new Error("D1 unavailable");
          return store.runsByIds();
        },
        enrollmentsByIds: store.enrollmentsByIds,
      },
    );
    const body = await view(server);
    expect(calls).toBe(2);
    expect(body.sources).toMatchObject({
      agents: "ok",
      runs: "unavailable",
      enrollments: "ok",
    });
    // agent-055's lapsed run cannot be seen during the outage, so it is
    // unknown only because of the source and is left out; the epoch mismatch
    // is evidence about the occupant and still counts.
    expect(body.rows.map((row) => row.agent.id)).toEqual([
      agentId(10),
      agentId(58),
    ]);
    expect(body.total).toBe(2);
    expect(body.rows[1].current?.observation).toMatchObject({
      lifecycle: "unknown",
      reasons: ["epoch-mismatch"],
    });
    expect(body.scan).toEqual({ agents: 60, complete: true });
  });

  it("counts nothing when runs are unavailable for every page", async () => {
    const { server } = app(directory(60, { 10: "expired", 55: "expired" }), {
      runsByIds: async () => {
        throw new Error("D1 unavailable");
      },
      enrollmentsByIds: store.enrollmentsByIds,
    });
    const body = await view(server);
    expect(body.sources.runs).toBe("unavailable");
    expect(body.total).toBe(0);
    expect(body.rows).toEqual([]);
  });

  it("pages over the matches with limit and cursor", async () => {
    const matches = [5, 20, 60, 61, 110];
    const { server } = app(
      directory(
        120,
        Object.fromEntries(matches.map((i) => [i, "expired" as const])),
      ),
      store,
    );
    const ids: string[] = [];
    const cursors: (string | null)[] = [];
    let cursor: string | null = null;
    do {
      const body = await view(
        server,
        `&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      expect(body.total).toBe(matches.length);
      expect(body.rows.length).toBeLessThanOrEqual(2);
      ids.push(...body.rows.map((row) => row.agent.id));
      cursor = body.next_cursor;
      cursors.push(cursor && decodeRuntimeCursor(cursor));
    } while (cursor);
    expect(ids).toEqual(matches.map(agentId));
    expect(cursors).toEqual([agentId(20), agentId(61), null]);
    // A page that ends exactly on the last match has no next cursor.
    const exact = await view(server, `&limit=${matches.length}`);
    expect(exact.rows).toHaveLength(matches.length);
    expect(exact.next_cursor).toBeNull();
  });

  it("rejects the filter combined with a single agent", () => {
    const combined = RuntimeViewQuerySchema.safeParse({
      filter: "attention",
      agent: "worker",
    });
    expect(combined.success).toBe(false);
    expect(combined.error?.issues[0]?.path).toEqual(["filter"]);
    expect(
      RuntimeViewQuerySchema.safeParse({ filter: "attention" }).success,
    ).toBe(true);
    expect(RuntimeViewQuerySchema.safeParse({ filter: "stale" }).success).toBe(
      false,
    );
  });
});
