import {
  AgentRegistrationSchema,
  AttachAgentBindingSchema,
  CreateRoomSchema,
  PublishMessageSchema,
  type RuntimeIdentity,
} from "@tila/schemas";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as ops from "../../../ops-sqlite/src/agent-binding-ops";
import { RevisionConflictError } from "../../../ops-sqlite/src/config-revision-ops";
import * as conversations from "../../../ops-sqlite/src/conversation-ops";
import { createAgentRoutes } from "../../src/do/routes/agent-routes";
import type { RouterDeps } from "../../src/do/routes/types";
import { createTestDb } from "./helpers/create-test-db";

describe("agent management revisions and archive", () => {
  let f: ReturnType<typeof createTestDb>;
  const now = 100_000;
  const enrollment = crypto.randomUUID();
  const manager: ops.AgentAuthority = {
    principal_id: "owner",
    participant_id: "dashboard",
    can_manage: true,
    runtime: null,
  };
  const viewer: ops.AgentAuthority = { ...manager, can_manage: false };
  const run = (overrides: Partial<RuntimeIdentity> = {}): RuntimeIdentity => ({
    run_id: crypto.randomUUID(),
    agent_id: "worker",
    run_role: "acting",
    principal_id: "service:one",
    participant_id: crypto.randomUUID(),
    enrollment_id: enrollment,
    workload_binding_id: null,
    lease_expires_at: 500,
    ...overrides,
  });
  const holder = (runtime = run()): ops.AgentAuthority => ({
    principal_id: runtime.principal_id,
    can_manage: false,
    runtime,
  });
  const attachInput = (epoch: number, profile?: Record<string, unknown>) =>
    AttachAgentBindingSchema.parse({
      expected_epoch: epoch,
      harness: "claude-code",
      capability_report: {
        protocol: 1,
        adapter_version: "test",
        capabilities: {},
      },
      ...(profile ? { profile } : {}),
    });
  const revision = () => ops.view(f.db, "worker", manager).agent.revision;
  beforeEach(() => {
    f = createTestDb({ foreignKeys: "on" });
    ops.register(
      f.db,
      AgentRegistrationSchema.parse({
        id: "worker",
        name: "Worker",
        bind_policy: [{ principal_id: "service:one", agent_id: "worker" }],
      }),
      manager,
      now,
    );
  });
  afterEach(() => f.sqlite.close());

  it("updates configured policy against the reviewed revision only", () => {
    const start = revision();
    const updated = ops.update(
      f.db,
      "worker",
      { expected_revision: start, name: "Builder" },
      manager,
      undefined,
      now,
    );
    expect(updated).toMatchObject({ name: "Builder" });
    expect(updated.revision).toBeGreaterThan(start);

    // A second editor still holding the old revision conflicts with the
    // current revision rather than overwriting the rename.
    const stale = () =>
      ops.update(
        f.db,
        "worker",
        { expected_revision: start, name: "Stale" },
        manager,
        undefined,
        now,
      );
    expect(stale).toThrow(RevisionConflictError);
    try {
      stale();
    } catch (error) {
      expect((error as RevisionConflictError).revision).toBe(updated.revision);
    }
    expect(ops.view(f.db, "worker", manager).agent.name).toBe("Builder");

    // A no-op keeps the revision.
    expect(
      ops.update(
        f.db,
        "worker",
        { expected_revision: updated.revision, name: "Builder" },
        manager,
      ).revision,
    ).toBe(updated.revision);
    const events = f.sqlite
      .prepare(
        "SELECT data FROM journal WHERE kind='agent.updated' ORDER BY seq",
      )
      .all() as { data: string }[];
    expect(events.map((row) => JSON.parse(row.data))).toEqual([
      { revision: updated.revision, changed: ["name"] },
    ]);
  });

  it("requires management authority and grants naming the agent", () => {
    expect(() =>
      ops.update(f.db, "worker", { expected_revision: 1, name: "x" }, viewer),
    ).toThrow(/agents:manage/);
    expect(() =>
      ops.update(
        f.db,
        "worker",
        {
          expected_revision: revision(),
          bind_policy: [{ principal_id: "service:two", agent_id: "other" }],
        },
        manager,
      ),
    ).toThrow(/name this agent/);
    expect(() =>
      ops.update(f.db, "missing", { expected_revision: 1, name: "x" }, manager),
    ).toThrow(/not found/);
  });

  it("a rename or policy change never replaces the active binding", () => {
    const binding = ops.attach(f.db, "worker", attachInput(0), holder(), now);
    ops.update(
      f.db,
      "worker",
      {
        expected_revision: revision(),
        name: "Renamed",
        profile_selection: {
          profile_id: "other",
          host_ref: null,
          account_ref: null,
        },
      },
      manager,
    );
    expect(ops.current(f.db, "worker")).toMatchObject({
      consumer_binding_id: binding.consumer_binding_id,
      binding_epoch: binding.binding_epoch,
      state: "active",
    });
  });

  it("enforces the profile selection on new attaches but lets the bound run renew", () => {
    const first = holder();
    const profile = {
      profile_id: "main",
      profile_revision: 1,
      account_ref: "acct-a",
      verification: "declared",
    };
    ops.attach(f.db, "worker", attachInput(0, profile), first, now);
    ops.update(
      f.db,
      "worker",
      {
        expected_revision: revision(),
        profile_selection: {
          profile_id: "main",
          account_ref: "acct-b",
          host_ref: enrollment,
        },
      },
      manager,
    );
    // Same run renews its unchanged attachment.
    expect(
      ops.attach(f.db, "worker", attachInput(0, profile), first, now + 1).state,
    ).toBe("active");
    // A new run reporting the old account is rejected.
    expect(() =>
      ops.attach(f.db, "worker", attachInput(1, profile), holder(), now),
    ).toThrow(/selected profile/);
    expect(() =>
      ops.attach(
        f.db,
        "worker",
        attachInput(1, { ...profile, account_ref: "acct-b" }),
        holder(run({ enrollment_id: crypto.randomUUID() })),
        now,
      ),
    ).toThrow(/selected profile/);
    const replaced = ops.attach(
      f.db,
      "worker",
      attachInput(1, { ...profile, account_ref: "acct-b" }),
      holder(),
      now,
    );
    expect(replaced.binding_epoch).toBe(2);
    // Clearing the selection restores unconstrained attaches.
    ops.update(
      f.db,
      "worker",
      { expected_revision: revision(), profile_selection: null },
      manager,
    );
    expect(
      ops.attach(f.db, "worker", attachInput(2), holder(), now).binding_epoch,
    ).toBe(3);
  });

  it("archiving releases the reviewed binding and its authority in one step", async () => {
    const bound = holder();
    const binding = ops.attach(f.db, "worker", attachInput(0), bound, now);
    const preview = ops.archivePreview(f.db, "worker", manager, now);
    expect(preview).toMatchObject({
      archived: false,
      binding: { binding_epoch: binding.binding_epoch, state: "active" },
      pending_deliveries: 0,
    });
    expect(() =>
      ops.archive(
        f.db,
        "worker",
        { expected_revision: preview.revision },
        manager,
        undefined,
        now,
      ),
    ).toThrow(/review it before archiving/);
    const result = ops.archive(
      f.db,
      "worker",
      { expected_revision: preview.revision, expected_epoch: 1 },
      manager,
      undefined,
      now,
    );
    expect(result.released).toEqual({
      consumer_binding_id: binding.consumer_binding_id,
      binding_epoch: 1,
    });
    expect(result.agent).toMatchObject({ archived: true, binding_epoch: 2 });
    expect(ops.current(f.db, "worker")).toBeNull();
    // The former holder can neither renew nor reattach.
    expect(() =>
      ops.attach(f.db, "worker", attachInput(1), bound, now),
    ).toThrow();
    expect(() => ops.authorizeRun(f.db, "worker", "service:one")).toThrow(
      /not accessible/,
    );
    // Reads hide archived agents except for managers who ask.
    expect(ops.list(f.db, manager)).toEqual([]);
    expect(ops.list(f.db, viewer, { includeArchived: true })).toEqual([]);
    expect(
      ops.list(f.db, manager, { includeArchived: true })[0].agent,
    ).toMatchObject({ id: "worker", archived: true });
  });

  it("archived agents stop receiving room fan-out; explicit targets fail", async () => {
    const owner = { ...manager, participant_id: "dashboard" };
    conversations.createRoom(
      f.db,
      CreateRoomSchema.parse({ id: "general", name: "General" }),
      owner,
      now,
    );
    conversations.setMember(f.db, "general", "agent:worker", true, owner, now);
    ops.archive(
      f.db,
      "worker",
      { expected_revision: revision() },
      manager,
      undefined,
      now,
    );
    const published = await conversations.publish(
      f.db,
      "general",
      PublishMessageSchema.parse({ client_op_id: "a", body: "hi" }),
      owner,
      now,
    );
    expect(published.replayed).toBe(false);
    expect(
      f.sqlite.prepare("SELECT count(*) AS n FROM message_recipients").get(),
    ).toEqual({ n: 0 });
    await expect(
      conversations.publish(
        f.db,
        "general",
        PublishMessageSchema.parse({
          client_op_id: "b",
          body: "hi",
          targets: [{ kind: "agent", agent_id: "worker" }],
        }),
        owner,
        now,
      ),
    ).rejects.toMatchObject({ code: "agent-archived" });
    // Removing the archived member still works; re-adding does not.
    conversations.setMember(f.db, "general", "agent:worker", null, owner, now);
    expect(() =>
      conversations.setMember(
        f.db,
        "general",
        "agent:worker",
        true,
        owner,
        now,
      ),
    ).toThrow(/Archived agents/);
  });

  it("unarchive restores identity only; the old epoch stays stale", () => {
    const bound = holder();
    ops.attach(f.db, "worker", attachInput(0), bound, now);
    const archived = ops.archive(
      f.db,
      "worker",
      { expected_revision: revision(), expected_epoch: 1 },
      manager,
    );
    expect(() =>
      ops.register(
        f.db,
        AgentRegistrationSchema.parse({
          id: "worker",
          name: "Worker",
          bind_policy: [{ principal_id: "service:one", agent_id: "worker" }],
        }),
        manager,
      ),
    ).toThrow(/archived/);
    const restored = ops.unarchive(
      f.db,
      "worker",
      archived.agent.revision,
      manager,
    );
    expect(restored).toMatchObject({ archived: false, binding_epoch: 2 });
    expect(ops.current(f.db, "worker")).toBeNull();
    expect(() =>
      ops.attach(f.db, "worker", attachInput(1), holder(), now),
    ).toThrow(/epoch/);
    expect(
      ops.attach(f.db, "worker", attachInput(2), holder(), now).binding_epoch,
    ).toBe(3);
  });

  it("DO routes replay idempotent edits and report the current revision on conflict", async () => {
    const app = createAgentRoutes({ db: f.db } as RouterDeps);
    const headers = {
      "Content-Type": "application/json",
      "X-Tila-Agent-Authority": JSON.stringify(manager),
      "Idempotency-Key": "dp:project:caller:PATCH:/agents/worker:one",
      "X-Idempotency-Hash": "hash-one",
    };
    const body = JSON.stringify({ expected_revision: revision(), name: "One" });
    const first = await app.request("/agents/worker", {
      method: "PATCH",
      headers,
      body,
    });
    expect(first.status).toBe(200);
    const replay = await app.request("/agents/worker", {
      method: "PATCH",
      headers,
      body,
    });
    expect(await replay.text()).toBe(await first.clone().text());
    const stale = await app.request("/agents/worker", {
      method: "PATCH",
      headers: {
        ...headers,
        "Idempotency-Key": "dp:other",
        "X-Idempotency-Hash": "h",
      },
      body,
    });
    expect(stale.status).toBe(412);
    expect(await stale.json()).toMatchObject({
      ok: false,
      error: {
        code: "revision-conflict",
        revision: revision(),
        resource: "agent:worker",
      },
    });
    const denied = await app.request("/agents/worker/archive-preview", {
      headers: { "X-Tila-Agent-Authority": JSON.stringify(viewer) },
    });
    expect(denied.status).toBe(403);
  });
});
