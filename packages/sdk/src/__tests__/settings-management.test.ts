import { describe, expect, it, vi } from "vitest";
import { createAgentMethods } from "../agents";
import { TilaApiError, TilaClient } from "../client";
import { createConversationMethods } from "../conversations";
import { createSignalMethods } from "../signals";

function setup() {
  const fetch = vi.fn<typeof globalThis.fetch>();
  const client = new TilaClient({
    baseUrl: "https://example.test",
    token: "fixture",
    participantId: "participant",
    fetch,
  });
  const call = (index: number) => {
    const [url, init] = fetch.mock.calls[index];
    const headers = new Headers(init?.headers);
    return {
      url: String(url),
      method: init?.method,
      key: headers.get("Idempotency-Key"),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
  };
  return { fetch, client, call };
}

const agent = {
  id: "worker",
  name: "Builder",
  owner_principal_id: "owner",
  bind_policy: [],
  binding_epoch: 2,
  archived: false,
  revision: 7,
  profile_selection: null,
  created_at: 1,
  updated_at: 2,
};
const room = {
  id: "general",
  name: "General",
  history_policy: "members",
  delivery_ttl_seconds: 3600,
  budgets: { max_hops: 8, pair_exchanges: 10, agent_wakes: 20, room_wakes: 60 },
  archived: false,
  revision: 4,
  created_at: 1,
  updated_at: 1,
};

describe("agent settings methods", () => {
  it("sends revision-checked writes with an idempotency key", async () => {
    const { fetch, client, call } = setup();
    const agents = createAgentMethods(client, "project");
    fetch.mockResolvedValueOnce(Response.json({ ok: true, agent }));
    await agents.update(
      "worker",
      {
        expected_revision: 6,
        profile_selection: { profile_id: "main" },
      },
      { idempotencyKey: "retry-me" },
    );
    expect(call(0)).toMatchObject({
      url: "https://example.test/projects/project/agents/worker",
      method: "PATCH",
      key: "retry-me",
      body: {
        expected_revision: 6,
        profile_selection: {
          profile_id: "main",
          host_ref: null,
          account_ref: null,
        },
      },
    });
    fetch.mockResolvedValueOnce(
      Response.json({
        ok: true,
        agent: { ...agent, archived: true },
        released: null,
        pending_deliveries: 0,
      }),
    );
    await agents.archive("worker", { expected_revision: 7, expected_epoch: 2 });
    expect(call(1)).toMatchObject({
      url: "https://example.test/projects/project/agents/worker/archive",
      body: { expected_revision: 7, expected_epoch: 2 },
    });
    expect(call(1).key).toMatch(/^[0-9a-f-]{36}$/);
    fetch.mockResolvedValueOnce(Response.json({ ok: true, agents: [] }));
    await agents.list({ includeArchived: true });
    expect(call(2).url).toBe(
      "https://example.test/projects/project/agents?include_archived=true",
    );
  });

  it("exposes the current revision on a conflict", async () => {
    const { fetch, client } = setup();
    const agents = createAgentMethods(client, "project");
    fetch.mockResolvedValueOnce(
      Response.json(
        {
          ok: false,
          error: {
            code: "revision-conflict",
            message: "agent:worker changed; current revision is 9",
            retryable: false,
            revision: 9,
            resource: "agent:worker",
          },
        },
        { status: 412 },
      ),
    );
    const error = await agents
      .update("worker", { expected_revision: 7, name: "Late" })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TilaApiError);
    expect(error).toMatchObject({
      code: "revision-conflict",
      extras: { revision: 9 },
    });
  });

  it("rejects malformed updates before sending", () => {
    const { fetch, client } = setup();
    const agents = createAgentMethods(client, "project");
    expect(() => agents.update("worker", { expected_revision: 1 })).toThrow(
      /Provide name/,
    );
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("room settings methods", () => {
  it("updates, archives and changes members against a revision", async () => {
    const { fetch, client, call } = setup();
    const rooms = createConversationMethods(client, "project");
    fetch.mockResolvedValueOnce(Response.json({ ok: true, room }));
    await rooms.update("general", {
      expected_revision: 3,
      delivery_ttl_seconds: 3600,
    });
    expect(call(0)).toMatchObject({
      method: "PATCH",
      body: { expected_revision: 3, delivery_ttl_seconds: 3600 },
    });
    fetch.mockResolvedValueOnce(Response.json({ ok: true, room }));
    const joined = await rooms.join("general", "agent:worker", false, {
      expectedRevision: 4,
    });
    expect(joined.room?.revision).toBe(4);
    expect(call(1)).toMatchObject({
      method: "PUT",
      url: "https://example.test/projects/project/rooms/general/members/agent%3Aworker",
      body: { wake: false, expected_revision: 4 },
    });
    fetch.mockResolvedValueOnce(Response.json({ ok: true }));
    await rooms.leave("general", "agent:worker", { expectedRevision: 5 });
    expect(call(2).url).toBe(
      "https://example.test/projects/project/rooms/general/members/agent%3Aworker?expected_revision=5",
    );
    fetch.mockResolvedValueOnce(
      Response.json({ ok: true, room: { ...room, archived: true } }),
    );
    await rooms.archive("general", 6);
    expect(call(3)).toMatchObject({
      url: "https://example.test/projects/project/rooms/general/archive",
      body: { expected_revision: 6 },
    });
  });
});

describe("signal group settings methods", () => {
  it("creates only when asked and deletes against a revision", async () => {
    const { fetch, client, call } = setup();
    const signals = createSignalMethods(client, "project");
    fetch.mockResolvedValueOnce(
      Response.json({
        ok: true,
        group: {
          id: "reviewers",
          name: "Reviewers",
          principal_ids: [],
          revision: 3,
          created_at: 1,
          updated_at: 1,
        },
      }),
    );
    await signals.groups.set("reviewers", {
      name: "Reviewers",
      principal_ids: [],
      expected_revision: 0,
    });
    expect(call(0).body).toEqual({
      name: "Reviewers",
      principal_ids: [],
      expected_revision: 0,
    });
    fetch.mockResolvedValueOnce(Response.json({ ok: true }));
    await signals.groups.delete("reviewers", { expected_revision: 3 });
    expect(call(1)).toMatchObject({
      method: "DELETE",
      url: "https://example.test/projects/project/signals/groups/reviewers?expected_revision=3",
    });
  });
});
