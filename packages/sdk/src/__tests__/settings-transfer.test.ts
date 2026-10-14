import { createSettingsReceipt } from "@tila/core";
import {
  type SettingsPlan,
  SettingsPlanSchema,
  type SettingsReceipt,
} from "@tila/schemas";
import { describe, expect, it, vi } from "vitest";
import { TilaClient } from "../client";
import { createSettingsTransferMethods } from "../settings-transfer";
const op = "20000000-0000-4000-8000-000000000001";
function plan(actions: unknown[]): SettingsPlan {
  const coverage = {
    status: "omitted",
    scope: "visible",
    unavailable_fields: [],
  };
  return SettingsPlanSchema.parse({
    format: "tila-settings-plan",
    version: 1,
    operation_id: op,
    project_id: "destination",
    creator_member: "principal:owner",
    mappings: {
      identities: {},
      profiles: {},
      resources: { agents: {}, rooms: {}, signal_groups: {} },
    },
    references: [],
    removals: [],
    warnings: [],
    coverage: {
      definitions: coverage,
      agents: coverage,
      rooms: coverage,
      signal_groups: coverage,
    },
    actions: actions.map((a, index) => ({
      ...(a as object),
      id: `${op}:${index}`,
    })),
  });
}
const whoami = {
  ok: true,
  project_id: "destination",
  principal_id: "owner",
  auth_kind: "d1-token",
  scopes: "full",
  token_name: "fixture",
};
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
function client(fetch: typeof globalThis.fetch) {
  return new TilaClient({
    baseUrl: "https://worker",
    token: "fixture",
    participantId: "fixture",
    fetch,
  });
}
const denied = (status = 403) =>
  Response.json(
    {
      ok: false,
      error: {
        code: status === 412 ? "revision-conflict" : "permission-denied",
        message: "Rejected",
        retryable: false,
      },
    },
    { status },
  );
describe("settings SDK executor", () => {
  it("reconciles a stable-ID create after a lost response, reuses update key and skips committed work after reload", async () => {
    let creates = 0;
    let updates = 0;
    let current = { ...agent };
    const headers: string[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path === "/api/whoami") return Response.json(whoami);
      if (path.endsWith("/agents") && init?.method === "POST") {
        creates++;
        if (creates === 1) throw new Error("lost after commit");
        return Response.json({ ok: true, agent: current });
      }
      if (init?.method === "PATCH") {
        updates++;
        headers.push(
          new Headers(init.headers).get("Idempotency-Key") ?? "missing",
        );
        const body = JSON.parse(String(init.body));
        expect(body.expected_revision).toBe(1);
        current = { ...current, name: body.name, revision: 2 };
        return Response.json({ ok: true, agent: current });
      }
      throw new Error(`Unexpected ${path}`);
    });
    const methods = createSettingsTransferMethods(client(fetch), "destination");
    const p = plan([
      {
        kind: "agent.create",
        resource_id: "worker",
        payload: { id: "worker", name: "Worker", bind_policy: [] },
      },
      {
        kind: "agent.update",
        resource_id: "worker",
        revision_from: `${op}:0`,
        payload: { name: "Builder" },
      },
    ]);
    let saved: SettingsReceipt | undefined;
    const partial = await methods.execute(
      await createSettingsReceipt(p),
      (r) => {
        saved = r;
      },
    );
    expect(partial.actions[0].status).toBe("uncertain");
    const complete = await methods.execute(
      JSON.parse(JSON.stringify(saved)),
      (r) => {
        saved = r;
      },
    );
    expect(complete.actions.map((a) => a.status)).toEqual([
      "committed",
      "committed",
    ]);
    await methods.execute(complete, vi.fn());
    expect(creates).toBe(2);
    expect(updates).toBe(1);
    expect(headers).toEqual([`${op}:1`]);
  });
  it("refuses mismatched create collisions and altered exact initial state", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) =>
      init?.method === "POST" ? denied(409) : Response.json(whoami),
    );
    const methods = createSettingsTransferMethods(client(fetch), "destination");
    const p = plan([
      {
        kind: "agent.create",
        resource_id: "worker",
        payload: { id: "worker", name: "Worker", bind_policy: [] },
      },
    ]);
    const failed = await methods.execute(
      await createSettingsReceipt(p),
      vi.fn(),
    );
    expect(failed.actions[0].status).toBe("failed");
    fetch.mockImplementation(async (_url, init) =>
      init?.method === "POST"
        ? Response.json({
            ok: true,
            agent: {
              ...agent,
              profile_selection: {
                profile_id: "different",
                host_ref: null,
                account_ref: null,
              },
            },
          })
        : Response.json(whoami),
    );
    const uncertain = await methods.execute(
      await createSettingsReceipt(p),
      vi.fn(),
    );
    expect(uncertain.actions[0]).toMatchObject({
      status: "uncertain",
      error_code: "create-ambiguous",
    });
  });
  it("uses each preceding member revision, not the initial room revision", async () => {
    const revisions: number[] = [];
    let revision = 7;
    const room = {
      id: "team",
      name: "Team",
      history_policy: "members",
      delivery_ttl_seconds: 60,
      budgets: {
        max_hops: 1,
        pair_exchanges: 2,
        agent_wakes: 3,
        room_wakes: 4,
      },
      archived: false,
      revision,
      created_at: 1,
      updated_at: 1,
    };
    const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
      if (new URL(String(url)).pathname === "/api/whoami")
        return Response.json(whoami);
      if (init?.method === "GET")
        return Response.json({
          ok: true,
          room: { ...room, revision },
          members: [],
        });
      if (init?.method === "PUT") {
        const body = JSON.parse(String(init.body));
        revisions.push(body.expected_revision);
        expect(body.expected_revision).toBe(revision);
        revision++;
        return Response.json({ ok: true, room: { ...room, revision } });
      }
      throw new Error("unexpected");
    });
    const p = plan([
      {
        kind: "room.member",
        resource_id: "team",
        expected_revision: 7,
        payload: { member: "principal:first", wake: false },
      },
      {
        kind: "room.member",
        resource_id: "team",
        revision_from: `${op}:0`,
        payload: { member: "principal:second", wake: true },
      },
    ]);
    const result = await createSettingsTransferMethods(
      client(fetch),
      "destination",
    ).execute(await createSettingsReceipt(p), vi.fn());
    expect(result.actions.every((a) => a.status === "committed")).toBe(true);
    expect(revisions).toEqual([7, 8]);
  });
  it("keeps a concurrent destination update as a conflict and denies changed permission before replay", async () => {
    let authorized = true;
    let writes = 0;
    const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
      if (new URL(String(url)).pathname === "/api/whoami")
        return Response.json(
          authorized
            ? whoami
            : {
                ...whoami,
                role: "viewer",
                auth_kind: "cookie-session",
                policy: { role: "viewer", capabilities: ["agents:read"] },
              },
        );
      if (init?.method === "GET")
        return Response.json({
          ok: true,
          agent: { ...agent, revision: 99 },
          binding: null,
        });
      writes++;
      expect(JSON.parse(String(init?.body)).expected_revision).toBe(1);
      return denied(412);
    });
    const p = plan([
      {
        kind: "agent.update",
        resource_id: "worker",
        expected_revision: 1,
        payload: { name: "Builder" },
      },
    ]);
    const methods = createSettingsTransferMethods(client(fetch), "destination");
    const partial = await methods.execute(
      await createSettingsReceipt(p),
      vi.fn(),
    );
    expect(partial.actions[0]).toMatchObject({
      status: "failed",
      sent_revision: 1,
      error_code: "revision-conflict",
    });
    authorized = false;
    await expect(methods.execute(partial, vi.fn())).rejects.toMatchObject({
      code: "permission-denied",
    });
    expect(writes).toBe(1);
  });
});
