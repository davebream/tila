import { browserSettingsTransfer } from "@/lib/settings-transfer";
import { createSettingsReceipt } from "@tila/core";
import { SettingsPlanSchema } from "@tila/schemas";
import { http, HttpResponse } from "msw";
import { expect, it, vi } from "vitest";
import { server } from "../mocks/server";
const project = "test-project";
const identity = {
  ok: true,
  project_id: project,
  principal_id: "owner",
  auth_kind: "d1-token",
  scopes: "full",
  token_name: "fixture",
};
function plan(actions: object[], identities = {}) {
  const c = { status: "omitted", scope: "visible", unavailable_fields: [] };
  const op = crypto.randomUUID();
  return SettingsPlanSchema.parse({
    format: "tila-settings-plan",
    version: 1,
    operation_id: op,
    project_id: project,
    creator_member: "principal:owner",
    mappings: {
      identities,
      profiles: {},
      resources: { agents: {}, rooms: {}, signal_groups: {} },
    },
    references: Object.keys(identities),
    removals: [],
    warnings: [],
    coverage: { definitions: c, agents: c, rooms: c, signal_groups: c },
    actions: actions.map((a, i) => ({
      ...a,
      id: `${op}:${i}`,
      ...("revision_from_index" in a
        ? { revision_from: `${op}:${a.revision_from_index}` }
        : {}),
    })),
  });
}
const agent = {
  id: "worker",
  name: "Worker",
  owner_principal_id: "owner",
  archived: false,
  revision: 1,
  bind_policy: [],
  profile_selection: null,
  binding_epoch: 0,
  created_at: 1,
  updated_at: 1,
};
it("uses the production browser API adapter and sends chained room revisions and retained operation keys", async () => {
  const config = {
    id: "team",
    name: "Team",
    history_policy: "members",
    delivery_ttl_seconds: 60,
    budgets: { max_hops: 1, pair_exchanges: 2, agent_wakes: 3, room_wakes: 4 },
  };
  let revision = 11;
  const writes: {
    method: string;
    key: string | null;
    expected: number;
    protocol: string | null;
  }[] = [];
  server.use(
    http.get("*/api/whoami", () => HttpResponse.json(identity)),
    http.get("*/projects/test-project/agents", () =>
      HttpResponse.json({ ok: true, agents: [{ agent, binding: null }] }),
    ),
    http.post("*/projects/test-project/rooms", async ({ request }) => {
      expect(await request.json()).toEqual(config);
      return HttpResponse.json({
        ok: true,
        room: {
          ...config,
          archived: false,
          revision,
          created_at: 1,
          updated_at: 1,
        },
      });
    }),
    http.get("*/projects/test-project/rooms/team", () =>
      HttpResponse.json({
        ok: true,
        room: {
          ...config,
          archived: false,
          revision,
          created_at: 1,
          updated_at: 1,
        },
        members: [{ member: "principal:owner", wake: false }],
      }),
    ),
    http.put(
      "*/projects/test-project/rooms/team/members/:member",
      async ({ request }) => {
        const body = (await request.json()) as { expected_revision: number };
        writes.push({
          method: "PUT",
          key: request.headers.get("Idempotency-Key"),
          expected: body.expected_revision,
          protocol: request.headers.get("X-Tila-Conversation-Protocol"),
        });
        expect(body.expected_revision).toBe(revision);
        revision++;
        return HttpResponse.json({
          ok: true,
          room: {
            ...config,
            archived: false,
            revision,
            created_at: 1,
            updated_at: 1,
          },
        });
      },
    ),
    http.delete(
      "*/projects/test-project/rooms/team/members/:member",
      ({ request }) => {
        const expected = Number(
          new URL(request.url).searchParams.get("expected_revision"),
        );
        writes.push({
          method: "DELETE",
          key: request.headers.get("Idempotency-Key"),
          expected,
          protocol: request.headers.get("X-Tila-Conversation-Protocol"),
        });
        expect(expected).toBe(revision);
        revision++;
        return HttpResponse.json({
          ok: true,
          room: {
            ...config,
            archived: false,
            revision,
            created_at: 1,
            updated_at: 1,
          },
        });
      },
    ),
  );
  const p = plan(
    [
      { kind: "room.create", resource_id: "team", payload: config },
      {
        kind: "room.member",
        resource_id: "team",
        expected_revision: 11,
        payload: { member: "agent:worker", wake: true },
      },
      {
        kind: "room.member",
        resource_id: "team",
        expected_revision: 12,
        payload: { member: "principal:owner", wake: null },
      },
    ],
    { "agent:source": { target: "worker" } },
  );
  p.actions[1].expected_revision = undefined;
  p.actions[1].revision_from = p.actions[0].id;
  p.actions[2].expected_revision = undefined;
  p.actions[2].revision_from = p.actions[1].id;
  const result = await browserSettingsTransfer(project).execute(
    await createSettingsReceipt(p),
    vi.fn(),
  );
  expect(result.actions.every((a) => a.status === "committed")).toBe(true);
  expect(writes).toEqual([
    { method: "PUT", key: p.actions[1].id, expected: 11, protocol: "1" },
    { method: "DELETE", key: p.actions[2].id, expected: 12, protocol: "1" },
  ]);
});
it("retains create operation IDs through the production browser adapter after a lost response", async () => {
  const keys: (string | null)[] = [];
  server.use(
    http.get("*/api/whoami", () => HttpResponse.json(identity)),
    http.post("*/projects/test-project/agents", ({ request }) => {
      keys.push(request.headers.get("Idempotency-Key"));
      return keys.length === 1
        ? HttpResponse.error()
        : HttpResponse.json({ ok: true, agent });
    }),
  );
  const p = plan([
    {
      kind: "agent.create",
      resource_id: "worker",
      payload: { id: "worker", name: "Worker", bind_policy: [] },
    },
  ]);
  const transfer = browserSettingsTransfer(project);
  const partial = await transfer.execute(
    await createSettingsReceipt(p),
    vi.fn(),
  );
  expect(partial.actions[0].status).toBe("uncertain");
  const complete = await transfer.execute(
    JSON.parse(JSON.stringify(partial)),
    vi.fn(),
  );
  expect(complete.actions[0].status).toBe("committed");
  expect(keys).toEqual([p.actions[0].id, p.actions[0].id]);
});
