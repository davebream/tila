import {
  AgentRegistrationSchema,
  AttachAgentBindingSchema,
} from "@tila/schemas";
import { describe, expect, it, vi } from "vitest";
import { createAgentMethods } from "../agents";
import { TilaApiError, TilaClient } from "../client";

describe("agent SDK contracts", () => {
  it("validates requests, accepts redacted binding projections and keeps errors typed", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const client = new TilaClient({
      baseUrl: "https://example.test",
      token: "fixture",
      participantId: "participant",
      fetch,
    });
    const agents = createAgentMethods(client, "project");
    const agent = {
      id: "worker",
      name: "Worker",
      owner_principal_id: "owner",
      bind_policy: [],
      binding_epoch: 1,
      archived: false,
      created_at: 1,
      updated_at: 1,
    };
    const binding = {
      consumer_binding_id: crypto.randomUUID(),
      agent_id: "worker",
      binding_epoch: 1,
      state: "active",
      mechanism: "poll",
      lease_expires_at: 2000,
    };
    fetch.mockResolvedValueOnce(Response.json({ ok: true, agent, binding }));
    expect((await agents.get("worker")).binding).toEqual(binding);
    expect(String(fetch.mock.calls[0][0])).toBe(
      "https://example.test/projects/project/agents/worker",
    );
    const input = AgentRegistrationSchema.parse({
      id: "second",
      name: "Second",
    });
    fetch.mockResolvedValueOnce(
      Response.json({ ok: true, agent: { ...agent, ...input } }),
    );
    await agents.register(input);
    expect(JSON.parse(String(fetch.mock.calls[1][1]?.body))).toEqual(input);
    fetch.mockResolvedValueOnce(
      Response.json(
        {
          ok: false,
          error: {
            code: "stale-binding",
            message: "Binding changed",
            retryable: false,
          },
        },
        { status: 409 },
      ),
    );
    const failure = agents.bind(
      "worker",
      AttachAgentBindingSchema.parse({
        expected_epoch: 0,
        harness: "cli",
        capability_report: {
          protocol: 1,
          adapter_version: "fixture",
          capabilities: {},
        },
      }),
    );
    await expect(failure).rejects.toBeInstanceOf(TilaApiError);
    await expect(failure).rejects.toMatchObject({
      code: "stale-binding",
      retryable: false,
    });
    expect(() => agents.get("../other")).toThrow();
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("requests the bounded runtime view and validates its contract", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const client = new TilaClient({
      baseUrl: "https://example.test",
      token: "fixture",
      participantId: "participant",
      fetch,
    });
    const agents = createAgentMethods(client, "project");
    const view = {
      ok: true,
      server_now: 1000,
      sources: {
        agents: "ok",
        runs: "unavailable",
        enrollments: "ok",
        presence: "forbidden",
      },
      rows: [],
      next_cursor: null,
    };
    fetch.mockResolvedValueOnce(Response.json(view));
    expect(await agents.runtimeView({ limit: 5, agent: "worker" })).toEqual(
      view,
    );
    const url = new URL(String(fetch.mock.calls[0][0]));
    expect(url.pathname).toBe("/projects/project/runtime-view");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      limit: "5",
      agent: "worker",
    });
    expect(() => agents.runtimeView({ limit: 51 })).toThrow();
    fetch.mockResolvedValueOnce(Response.json({ ...view, rows: [{}] }));
    await expect(agents.runtimeView()).rejects.toThrow();
  });

  it("sends the attention filter and accepts its total and scan", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const client = new TilaClient({
      baseUrl: "https://example.test",
      token: "fixture",
      participantId: "participant",
      fetch,
    });
    const agents = createAgentMethods(client, "project");
    const view = {
      ok: true,
      server_now: 1000,
      sources: {
        agents: "ok",
        runs: "ok",
        enrollments: "ok",
        presence: "ok",
      },
      rows: [],
      next_cursor: null,
      total: 0,
      scan: { agents: 3, complete: true },
    };
    fetch.mockResolvedValueOnce(Response.json(view));
    expect(
      await agents.runtimeView({ filter: "attention", limit: 10 }),
    ).toEqual(view);
    const url = new URL(String(fetch.mock.calls[0][0]));
    expect(url.pathname).toBe("/projects/project/runtime-view");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      filter: "attention",
      limit: "10",
    });
    // A filter scans every agent, so it cannot be narrowed to one agent.
    expect(() =>
      agents.runtimeView({ filter: "attention", agent: "worker" }),
    ).toThrow();
    expect(() =>
      agents.runtimeView({ filter: "everything" as "attention" }),
    ).toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
