import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import type { RuntimeRunContext } from "@tila/schemas";
import type { TilaFacade } from "tila-sdk";
import { afterEach, expect, it, vi } from "vitest";
import { HostConnector, type RelayFactory } from "../src/connector";
import type { DiscoveredSession, SessionDiscovery } from "../src/discovery";
import { ConnectorStore } from "../src/store";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync("/tmp/tila-engine-");
  roots.push(root);
  const store = new ConnectorStore(root);
  const bindingId = randomUUID();
  const acting = randomUUID();
  const enrollment = randomUUID();
  const session = {
    state: {
      key: "a".repeat(64),
      generation: randomUUID(),
      owner: { pid: 123, started: "one" },
      profile: { id: "account-a", revision: 1 },
      namespace: '["https://tila.test","project"]',
      client: "codex",
      sessionId: "native-1",
    },
    context: {
      run_id: acting,
      agent_id: "coordinator",
      run_role: "acting",
      enrollment_id: enrollment,
      project_id: "project",
      instance_id: "instance",
    },
    capabilities: { protocol: 1, adapter_version: "1", capabilities: {} },
    evidence: {
      profile_id: "account-a",
      profile_revision: 1,
      account_ref: "redacted",
      verification: "declared",
    },
    mechanism: "native-queue",
  } as unknown as DiscoveredSession;
  const metadata = {
    ok: true,
    server_now: Date.now(),
    attempt: { outcome: "leased", created_at: Date.now() },
    binding: {
      consumer_binding_id: bindingId,
      binding_epoch: 1,
      mechanism: "native-queue",
    },
    outbox: { lease_token: null as string | null },
    deliveries: [
      {
        state: "pending",
        fetched_at: null as number | null,
        fetched_binding_id: bindingId,
        fetched_epoch: 1,
      },
    ],
  };
  const bind = vi.fn(async () => ({
    ok: true,
    binding: { consumer_binding_id: bindingId, binding_epoch: 1 },
  }));
  const lease = vi.fn(async () => {
    const token = randomUUID();
    metadata.outbox.lease_token = token;
    return {
      ok: true,
      lease: {
        lease_token: token,
        lease_until: Date.now() + 30_000,
        publish_gen: 1,
        consumer_binding_id: bindingId,
        binding_epoch: 1,
        native_session_ref: {
          host_ref: connector.ledger.hostRef,
          profile_id: "account-a",
          session_id: "native-1",
        },
        allow_idle_start: true,
      },
    };
  });
  const report = vi.fn(async () => ({ ok: true, replayed: false }));
  const status = vi.fn(async () => metadata);
  const api = {
    agents: { bind },
    dispatch: { lease, report, status },
  } as unknown as Pick<TilaFacade, "agents" | "dispatch">;
  const close = vi.fn(async () => {});
  const factory: RelayFactory = {
    start: vi.fn(async (_session, operationId) => ({
      api,
      context: {
        ...session.context,
        run_id: operationId,
        run_role: "relay",
      } as RuntimeRunContext,
      close,
    })),
    recover: vi.fn(async () => {}),
  };
  const discovery: SessionDiscovery = {
    discover: vi.fn(async () => session),
    wake: vi.fn(async () => "accepted"),
    close: vi.fn(),
  };
  const connector = new HostConnector(store, discovery, factory);
  const register = () =>
    connector.request({
      action: "register",
      key: session.state.key,
      expectedEpoch: 0,
      allowIdleStart: true,
    });
  return {
    connector,
    store,
    session,
    factory,
    discovery,
    bind,
    lease,
    report,
    status,
    metadata,
    close,
    register,
  };
}
it("keeps the acting run as holder and does not repeat accepted wakes before a matching fetch", async () => {
  const f = fixture();
  await f.register();
  await f.register();
  expect(f.factory.start).toHaveBeenCalledTimes(1);
  expect(f.bind).toHaveBeenCalledWith(
    "coordinator",
    expect.objectContaining({
      acting_run_id: f.session.context.run_id,
      expected_epoch: 0,
      profile: f.session.evidence,
    }),
  );
  await f.connector.tick();
  expect(f.discovery.wake).toHaveBeenCalledTimes(1);
  expect(f.report).toHaveBeenCalledWith(
    "coordinator",
    expect.objectContaining({ outcome: "accepted", binding_epoch: 1 }),
  );
  await f.connector.tick();
  expect(f.discovery.wake).toHaveBeenCalledTimes(1);
  expect(f.lease).toHaveBeenCalledTimes(1);
  expect(f.connector.status().registrations[0].pendingWake).toEqual({
    outcome: "accepted",
    reported: true,
  });
  f.metadata.deliveries[0].fetched_at = Date.now() + 1;
  await f.connector.tick();
  expect(f.lease).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(f.connector.status())).not.toMatch(
    /leaseToken|relayOperationId|account_ref/,
  );
});
it("persists wake intent before I/O and reconciles a crash without issuing another wake", async () => {
  const f = fixture();
  await f.register();
  vi.mocked(f.discovery.wake).mockImplementationOnce(async () => {
    expect(f.store.read().registrations[0].pending?.outcome).toBeUndefined();
    throw new Error("crashed after send");
  });
  await f.connector.tick();
  expect(f.close).toHaveBeenCalled();
  const restarted = new HostConnector(f.store, f.discovery, f.factory);
  await restarted.tick();
  expect(f.factory.recover).toHaveBeenCalled();
  expect(f.discovery.wake).toHaveBeenCalledTimes(1);
  expect(f.report).toHaveBeenCalledWith(
    "coordinator",
    expect.objectContaining({ outcome: "unknown" }),
  );
  await restarted.tick();
  expect(f.discovery.wake).toHaveBeenCalledTimes(1);
  f.metadata.deliveries[0].fetched_at = Date.now() + 1;
  await restarted.tick();
  expect(f.discovery.wake).toHaveBeenCalledTimes(2);
});
it("pauses changed occupants/accounts and closes only relay access", async () => {
  const f = fixture();
  await f.register();
  vi.mocked(f.discovery.discover).mockRejectedValue(
    new Error("profile mismatch or PID reuse"),
  );
  await f.connector.tick();
  expect(f.close).toHaveBeenCalledTimes(1);
  expect(f.discovery.wake).not.toHaveBeenCalled();
  expect(f.lease).not.toHaveBeenCalled();
  expect(f.connector.status().registrations[0].state).toBe("paused");
  await f.connector.tick();
  expect(f.factory.recover).toHaveBeenCalled();
  expect(f.factory.start).toHaveBeenCalledTimes(1);
});
it("rejects relay identity crossover before attachment", async () => {
  const f = fixture();
  const start = vi.mocked(f.factory.start);
  const original = start.getMockImplementation();
  start.mockImplementation(async (session, id) => {
    const relay = await original?.(session, id);
    if (!relay) throw new Error("fixture missing");
    return {
      ...relay,
      context: { ...relay.context, enrollment_id: randomUUID() },
    };
  });
  await expect(f.register()).rejects.toThrow("scope mismatch");
  expect(f.bind).not.toHaveBeenCalled();
  expect(f.close).toHaveBeenCalled();
});
it("never reports an old wake against a replacement binding", async () => {
  const f = fixture();
  await f.register();
  await f.connector.tick();
  f.report.mockClear();
  f.metadata.binding.binding_epoch = 2;
  await f.connector.tick();
  expect(f.report).not.toHaveBeenCalled();
  expect(f.discovery.wake).toHaveBeenCalledTimes(1);
  expect(f.connector.status().registrations[0].state).toBe("paused");
});

it("uses server attempt time and binding evidence even when the host clock differs", async () => {
  const f = fixture();
  await f.register();
  await f.connector.tick();
  f.metadata.attempt.created_at = 100;
  f.metadata.deliveries[0].fetched_at = 101;
  f.metadata.deliveries[0].fetched_epoch = 99;
  await f.connector.tick();
  expect(f.discovery.wake).toHaveBeenCalledTimes(1);
  f.metadata.deliveries[0].fetched_epoch = 1;
  await f.connector.tick();
  expect(f.discovery.wake).toHaveBeenCalledTimes(2);
});
