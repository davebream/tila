import {
  CREDENTIAL_PRESETS,
  CredentialPolicyReadSchema,
  CredentialPolicySchema,
  RUNTIME_RUN_CEILING,
} from "@tila/schemas";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RuntimeStore } from "../src/runtime-store";
import { createCredentialFixture } from "./helpers/credential-fixture";

describe("agent-pinned runtime credentials", () => {
  let f: ReturnType<typeof createCredentialFixture>;
  let store: RuntimeStore;
  const authorize = vi.fn(
    async (_project: string, _principal: string, agent: string) => {
      if (agent !== "one" && agent !== "two") throw new Error("not allowed");
    },
  );
  const secret = () => ({ id: crypto.randomUUID(), hash: crypto.randomUUID() });
  const request = () => ({
    operation_id: crypto.randomUUID(),
    jkt: "b".repeat(43),
    agent_id: "one",
  });
  beforeEach(() => {
    f = createCredentialFixture();
    store = new RuntimeStore(f.db, () => 1000, authorize);
    authorize.mockClear();
  });
  afterEach(() => f.sqlite.close());
  async function enroll(policy = CREDENTIAL_PRESETS.worker) {
    await store.invite("p", "owner", "host", policy, "invite");
    return store.enroll(
      "p",
      {
        operation_id: crypto.randomUUID(),
        installation_id: crypto.randomUUID(),
        name: "host",
        jkt: "a".repeat(43),
        policy,
      },
      null,
      policy,
      secret(),
      "invite",
    );
  }
  it("pins agent and role across retries and renewal", async () => {
    const parent = await enroll();
    const input = request();
    const run = await store.start(
      required(parent.enrollment_id),
      input,
      secret(),
    );
    expect(authorize).toHaveBeenCalledWith("p", parent.principal_id, "one");
    const retry = await store.start(
      required(parent.enrollment_id),
      input,
      secret(),
    );
    expect(retry).toMatchObject({
      agent_id: "one",
      run_role: "acting",
      run_id: run.run_id,
      participant_id: run.participant_id,
    });
    await expect(
      store.start(
        required(parent.enrollment_id),
        { ...input, agent_id: "two" },
        secret(),
      ),
    ).rejects.toMatchObject({ code: "runtime-binding-mismatch" });
    await expect(
      store.start(
        required(parent.enrollment_id),
        { ...input, agent_id: undefined },
        secret(),
      ),
    ).rejects.toMatchObject({ code: "runtime-binding-mismatch" });
    const renewed = await store.renew(
      required(run.run_id),
      retry.token_id,
      secret(),
    );
    expect(renewed).toMatchObject({ agent_id: "one", run_role: "acting" });
  });
  it("fails closed without agent authorization and preserves unpinned legacy runs", async () => {
    const parent = await enroll();
    await expect(
      store.start(
        required(parent.enrollment_id),
        { ...request(), agent_id: "forbidden" },
        secret(),
      ),
    ).rejects.toThrow(/not allowed/);
    const unconfigured = new RuntimeStore(f.db, () => 1000);
    await expect(
      unconfigured.start(required(parent.enrollment_id), request(), secret()),
    ).rejects.toMatchObject({ code: "runtime-policy-denied" });
    expect(
      await unconfigured.start(
        required(parent.enrollment_id),
        { operation_id: crypto.randomUUID(), jkt: "b".repeat(43) },
        secret(),
      ),
    ).toMatchObject({ agent_id: null, run_role: "acting" });
  });
  it("does not widen the default worker and enforces relay-only authority", async () => {
    expect(CREDENTIAL_PRESETS.worker.capabilities).not.toContain(
      "agent-bindings:attach",
    );
    const parent = await enroll(RUNTIME_RUN_CEILING);
    const input = {
      ...request(),
      run_role: "relay" as const,
      policy: CredentialPolicySchema.parse({
        role: "participant",
        capabilities: ["agent-bindings:attach"],
      }),
    };
    const relay = await store.start(
      required(parent.enrollment_id),
      input,
      secret(),
    );
    expect(relay.run_role).toBe("relay");
    await expect(
      store.start(
        required(parent.enrollment_id),
        { ...input, run_role: "acting" },
        secret(),
      ),
    ).rejects.toMatchObject({ code: "runtime-binding-mismatch" });
    await expect(
      store.start(
        required(parent.enrollment_id),
        {
          ...input,
          operation_id: crypto.randomUUID(),
          policy: CREDENTIAL_PRESETS.worker,
        },
        secret(),
      ),
    ).rejects.toMatchObject({ code: "runtime-policy-denied" });
  });
  it("ignores unknown capability strings on reads and rejects them during issuance", () => {
    const policy = {
      role: "participant",
      capabilities: ["agents:read", "future:capability"],
    };
    expect(CredentialPolicyReadSchema.parse(policy).capabilities).toEqual([
      "agents:read",
    ]);
    expect(CredentialPolicySchema.safeParse(policy).success).toBe(false);
    expect(
      CredentialPolicyReadSchema.safeParse({ ...policy, capabilities: [5] })
        .success,
    ).toBe(false);
  });
});

function required(value: string | null) {
  if (!value) throw new Error("Missing runtime identity");
  return value;
}
