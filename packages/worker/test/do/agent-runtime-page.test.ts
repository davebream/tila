import {
  AgentRegistrationSchema,
  AgentRuntimePageSchema,
  AttachAgentBindingSchema,
  type RuntimeIdentity,
} from "@tila/schemas";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as ops from "../../../ops-sqlite/src/agent-binding-ops";
import { heartbeat } from "../../../ops-sqlite/src/coordination-ops";
import * as schema from "../../../ops-sqlite/src/schema";
import { createAgentRoutes } from "../../src/do/routes/agent-routes";
import type { RouterDeps } from "../../src/do/routes/types";
import { createTestDb } from "./helpers/create-test-db";

describe("agent runtime page", () => {
  let f: ReturnType<typeof createTestDb>;
  const now = 100_000;
  const enrollment = crypto.randomUUID();
  const manager = { principal_id: "manager", can_manage: true, runtime: null };
  const stranger = { principal_id: "viewer", can_manage: false, runtime: null };
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
  const authority = (runtime: RuntimeIdentity): ops.AgentAuthority => ({
    principal_id: runtime.principal_id,
    can_manage: false,
    runtime,
  });
  const attach = (runtime: RuntimeIdentity, epoch: number, session: string) =>
    ops.attach(
      f.db,
      runtime.agent_id ?? "worker",
      AttachAgentBindingSchema.parse({
        expected_epoch: epoch,
        harness: "claude-code",
        native_session_ref: {
          host_ref: enrollment,
          harness: "claude-code",
          profile_id: "work",
          session_id: session,
        },
        profile: {
          profile_id: "work",
          profile_revision: 1,
          account_ref: "opaque-account",
          verification: "declared",
        },
        capability_report: {
          protocol: 1,
          adapter_version: "test",
          capabilities: {},
        },
      }),
      authority(runtime),
      now,
    );
  const register = (id: string) =>
    ops.register(
      f.db,
      AgentRegistrationSchema.parse({
        id,
        name: id,
        bind_policy: [{ principal_id: "service:one", agent_id: id }],
      }),
      { ...manager, principal_id: "owner" },
      now,
    );
  beforeEach(() => {
    f = createTestDb({ foreignKeys: "on" });
    for (const id of ["alpha", "worker", "zeta"]) register(id);
  });
  afterEach(() => f.sqlite.close());

  it("pages non-archived agents by id with a bounded limit", () => {
    f.db
      .update(schema.agents)
      .set({ archived: true })
      .where(eq(schema.agents.id, "zeta"))
      .run();
    const first = ops.runtimePage(f.db, manager, { limit: 1 }, now);
    expect(first.rows.map((row) => row.agent.id)).toEqual(["alpha"]);
    expect(first.next_after).toBe("alpha");
    const second = ops.runtimePage(
      f.db,
      manager,
      { limit: 1, after: "alpha" },
      now,
    );
    expect(second.rows.map((row) => row.agent.id)).toEqual(["worker"]);
    expect(second.next_after).toBeNull();
    expect(
      ops.runtimePage(f.db, manager, { limit: 5, agent: "worker" }, now).rows,
    ).toHaveLength(1);
  });

  it("keeps two sessions in one directory distinct and exposes the replaced occupant", () => {
    const first = run();
    const second = run();
    attach(first, 0, "session-one");
    for (const r of [first, second])
      heartbeat(
        f.db,
        {
          principalId: r.principal_id,
          participantId: r.participant_id,
          environment: { worktree: "/repo" },
        } as Parameters<typeof heartbeat>[1],
        {},
        now,
      );
    attach(second, 1, "session-two");
    const [row] = ops.runtimePage(
      f.db,
      manager,
      { limit: 5, agent: "worker" },
      now,
    ).rows;
    expect(row.current).toMatchObject({
      detail: "full",
      release_authorized: true,
      binding: {
        state: "active",
        binding_epoch: 2,
        holder: { run_id: second.run_id },
        native_session_ref: { session_id: "session-two" },
      },
      presence: {
        participant_id: second.participant_id,
        environment: { worktree: "/repo" },
      },
    });
    expect(row.previous).toMatchObject({
      binding: {
        state: "replaced",
        binding_epoch: 1,
        holder: { run_id: first.run_id },
        native_session_ref: { session_id: "session-one" },
      },
      presence: { participant_id: first.participant_id },
    });
    expect(row.previous).not.toHaveProperty("release_authorized");
  });

  it("marks detail per viewer with the same rule as the agent view", () => {
    const holder = run();
    attach(holder, 0, "session-one");
    const page = (viewer: ops.AgentAuthority) =>
      ops.runtimePage(f.db, viewer, { limit: 5, agent: "worker" }, now).rows[0]
        .current;
    expect(page(stranger)).toMatchObject({
      detail: "redacted",
      release_authorized: false,
    });
    expect(page({ ...stranger, principal_id: "owner" })).toMatchObject({
      detail: "full",
      release_authorized: true,
    });
    expect(page(authority(holder))).toMatchObject({
      detail: "full",
      release_authorized: true,
    });
    expect(ops.view(f.db, "worker", stranger).binding).toEqual({
      consumer_binding_id: page(manager)?.binding.consumer_binding_id,
      agent_id: "worker",
      binding_epoch: 1,
      state: "active",
      mechanism: "poll",
      lease_expires_at: 500,
    });
  });

  it("serves the internal DO route with validated bounds", async () => {
    attach(run(), 0, "session-one");
    const app = createAgentRoutes({ db: f.db } as RouterDeps);
    const headers = { "X-Tila-Agent-Authority": JSON.stringify(manager) };
    const response = await app.request(
      "/agents/internal/runtime-page?limit=2",
      { headers },
    );
    expect(response.status).toBe(200);
    const body = AgentRuntimePageSchema.parse(await response.json());
    expect(body.rows.map((row) => row.agent.id)).toEqual(["alpha", "worker"]);
    expect(body.next_after).toBe("worker");
    expect(
      (await app.request("/agents/internal/runtime-page?limit=51", { headers }))
        .status,
    ).toBe(400);
    expect(
      (await app.request("/agents/internal/runtime-page?limit=1")).status,
    ).toBe(403);
  });
});
