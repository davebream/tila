import {
  AgentRegistrationSchema,
  AttachAgentBindingSchema,
  type RuntimeIdentity,
} from "@tila/schemas";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as ops from "../../ops-sqlite/src/agent-binding-ops";
import * as schema from "../../ops-sqlite/src/schema";
import { createAgentRoutes } from "../src/routes/agent-routes";
import type { RouterDeps } from "../src/routes/types";
import { createTestDb } from "./helpers/create-test-db";

describe("agent binding authority and epochs", () => {
  let f: ReturnType<typeof createTestDb>;
  const now = 100_000;
  const enrollment = crypto.randomUUID();
  const owner = { principal_id: "owner", can_manage: true, runtime: null };
  const input = (epoch = 0) =>
    AttachAgentBindingSchema.parse({
      expected_epoch: epoch,
      harness: "claude-code",
      capability_report: {
        protocol: 1,
        adapter_version: "test",
        capabilities: { "io.tila/future": true },
      },
    });
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
  const authority = (runtime = run()): ops.AgentAuthority => ({
    principal_id: runtime.principal_id,
    can_manage: false,
    runtime,
  });
  beforeEach(() => {
    f = createTestDb({ foreignKeys: "on" });
    ops.register(
      f.db,
      AgentRegistrationSchema.parse({
        id: "worker",
        name: "Worker",
        bind_policy: [{ principal_id: "service:one", agent_id: "worker" }],
      }),
      owner,
      now,
    );
  });
  afterEach(() => f.sqlite.close());

  it("requires a current agent-pinned run even for an owner", () => {
    expect(() => ops.attach(f.db, "worker", input(), owner, now)).toThrow(
      /run/,
    );
    for (const runtime of [
      run({ agent_id: "other" }),
      run({ lease_expires_at: 100 }),
      run({ principal_id: "service:other" }),
    ]) {
      expect(() =>
        ops.attach(f.db, "worker", input(), authority(runtime), now),
      ).toThrow();
    }
    expect(ops.current(f.db, "worker")).toBeNull();
  });
  it("replays identical attach, replaces once, and rejects the old run even with a fresh epoch", () => {
    const first = authority();
    const binding = ops.attach(f.db, "worker", input(), first, now);
    expect(ops.attach(f.db, "worker", input(), first, now)).toEqual(binding);
    expect(() =>
      ops.attach(f.db, "worker", { ...input(), attended: false }, first, now),
    ).toThrow(/cannot change/);
    const second = ops.attach(f.db, "worker", input(1), authority(), now);
    expect(second.binding_epoch).toBe(2);
    expect(() => ops.attach(f.db, "worker", input(2), first, now)).toThrow(
      /replaced/,
    );
    expect(() =>
      ops.attach(f.db, "worker", input(1), authority(), now),
    ).toThrow(/epoch/);
    expect(ops.current(f.db, "worker")?.consumer_binding_id).toBe(
      second.consumer_binding_id,
    );
  });
  it("allows cross-host replacement only after Worker verification of the terminal holder", () => {
    const old = ops.attach(f.db, "worker", input(), authority(), now);
    const other = authority(run({ enrollment_id: crypto.randomUUID() }));
    expect(() => ops.attach(f.db, "worker", input(1), other, now)).toThrow(
      /another host/,
    );
    const replaced = ops.attach(
      f.db,
      "worker",
      input(1),
      { ...other, terminal_run_id: old.holder.run_id },
      now,
    );
    expect(replaced.binding_epoch).toBe(2);
  });
  it("a relay attaches the acting run and receives only redacted reads", () => {
    const acting = run();
    const relay = authority(run({ run_role: "relay" }));
    const bound = ops.attach(
      f.db,
      "worker",
      { ...input(), acting_run_id: acting.run_id },
      { ...relay, acting_runtime: acting },
      now,
    );
    expect(bound.holder.run_id).toBe(acting.run_id);
    expect(ops.view(f.db, "worker", relay).binding).not.toHaveProperty(
      "holder",
    );
    expect(ops.view(f.db, "worker", relay).agent.bind_policy).toEqual([]);
    expect(ops.view(f.db, "worker", authority(acting)).binding).toHaveProperty(
      "holder",
    );
    expect(() => ops.release(f.db, "worker", 1, relay, now)).toThrow();
    expect(() =>
      ops.attach(
        f.db,
        "worker",
        { ...input(), acting_run_id: acting.run_id },
        {
          ...relay,
          acting_runtime: { ...acting, enrollment_id: crypto.randomUUID() },
        },
        now,
      ),
    ).toThrow(/own enrollment/);
  });
  it("validates native profile and host names before attachment", () => {
    const details = {
      ...input(),
      profile: {
        profile_id: "one",
        profile_revision: 1,
        account_ref: "opaque",
        verification: "declared" as const,
      },
      native_session_ref: {
        host_ref: enrollment,
        harness: "claude-code",
        profile_id: "two",
        session_id: "native",
      },
    };
    expect(() => ops.attach(f.db, "worker", details, authority(), now)).toThrow(
      /profile/,
    );
    expect(ops.current(f.db, "worker")).toBeNull();
  });
  it("release and revocation never revive the same run", () => {
    const first = authority();
    ops.attach(f.db, "worker", input(), first, now);
    ops.release(f.db, "worker", 1, first, now);
    expect(() => ops.attach(f.db, "worker", input(1), first, now)).toThrow();
    const second = authority();
    ops.attach(f.db, "worker", input(1), second, now);
    ops.expire(f.db, { enrollment_id: enrollment }, now);
    expect(ops.current(f.db, "worker")).toBeNull();
    expect(() => ops.attach(f.db, "worker", input(2), second, now)).toThrow();
  });
  it("invalidates copied bindings and preserves the destination epoch high-water mark", () => {
    const first = authority();
    ops.attach(f.db, "worker", input(), first, now);
    f.db
      .insert(schema.projectTransferState)
      .values({
        singleton: 1,
        session_id: "restore",
        mode: "import",
        owner: "owner",
        started_at: now,
        updated_at: now,
        applying: 1,
        agent_epochs_json: JSON.stringify({ worker: 9 }),
      })
      .run();
    ops.invalidateRestoredBindings(f.db, now);
    expect(ops.current(f.db, "worker")).toBeNull();
    expect(ops.view(f.db, "worker", owner).agent.binding_epoch).toBe(10);
    expect(() => ops.attach(f.db, "worker", input(10), first, now)).toThrow();
    expect(
      ops.attach(f.db, "worker", input(10), authority(), now).binding_epoch,
    ).toBe(11);
  });
  it("protects the root DO route as well as child routes", async () => {
    const app = createAgentRoutes({ db: f.db } as RouterDeps);
    expect((await app.request("/agents")).status).toBe(403);
    const response = await app.request("/agents", {
      headers: { "X-Tila-Agent-Authority": JSON.stringify(owner) },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      agents: [{ agent: { id: "worker" } }],
    });
  });
});
