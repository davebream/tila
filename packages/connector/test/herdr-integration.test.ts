import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { processIdentity } from "@tila/client-lifecycle";
import type { RuntimeRunContext } from "@tila/schemas";
import type { TilaFacade } from "tila-sdk";
import { afterEach, expect, it, vi } from "vitest";
import { CompositeDiscovery } from "../src/composite-discovery";
import { HostConnector, type RelayFactory } from "../src/connector";
import { ConnectorControl, controlRequest } from "../src/control";
import {
  type DiscoveredSession,
  assertSameSession,
  identityMatches,
  sessionIdentity,
} from "../src/discovery";
import type { HerdrReadClient } from "../src/herdr";
import type { Registration } from "../src/store";
import { ConnectorStore } from "../src/store";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
function fixture(enabled = true) {
  const root = mkdtempSync("/tmp/tila-herdr-wiring-");
  const store = new ConnectorStore(join(root, "connector"));
  const owner = processIdentity(process.pid);
  if (!owner) throw new Error("Fixture process identity unavailable");
  const runId = randomUUID();
  const live = {
    state: {
      key: "a".repeat(64),
      generation: randomUUID(),
      owner,
      profile: { id: "account-a", revision: 1 },
      namespace: '["https://tila.test","project"]',
      client: "codex",
      sessionId: randomUUID(),
      participantId: "participant",
      runtime: { runId, socket: "/fixture-broker", capability: "fixture-only" },
    },
    context: {
      run_id: runId,
      agent_id: "worker",
      run_role: "acting",
      enrollment_id: randomUUID(),
      project_id: "project",
      instance_id: randomUUID(),
      participant_id: "participant",
      principal_id: "fixture-principal",
    },
    deployment: "https://tila.test",
    profile: { id: "account-a", revision: 1, harness: "codex" },
    evidence: {
      profile_id: "account-a",
      profile_revision: 1,
      account_ref: "fixture-account",
      verification: "declared",
    },
    capabilities: { protocol: 1, adapter_version: "1", capabilities: {} },
    mechanism: "native-queue",
  } as DiscoveredSession;
  const effect = vi.fn(async () => "accepted" as const);
  const native = {
    discover: vi.fn(async (_key: string, expected?: Registration) => {
      if (
        expected &&
        (!expected.identity ||
          !identityMatches(expected.identity, sessionIdentity(live)) ||
          expected.generation !== live.state.generation ||
          expected.profile.revision !== live.state.profile.revision ||
          expected.actingRunId !== live.context.run_id)
      )
        throw new Error("Pinned account or broker identity changed");
      return structuredClone(live);
    }),
    assertCurrent: (session: DiscoveredSession) =>
      assertSameSession(session, live),
    wake: vi.fn(
      async (
        _session: DiscoveredSession,
        _nonce: string,
        _idle: boolean,
        guard?: () => Promise<void>,
        check?: () => void,
      ) => {
        await guard?.();
        check?.();
        return effect();
      },
    ),
    close: vi.fn(),
  };
  let instance = "fixture-incarnation";
  let terminal = "fixture-terminal";
  let foreground = process.pid;
  const read: HerdrReadClient = {
    instance: () => instance,
    request: vi.fn(async (method) =>
      method === "session.snapshot"
        ? {
            snapshot: {
              version: "0.9.3",
              protocol: 22,
              panes: [
                {
                  pane_id: "w1:p1",
                  terminal_id: terminal,
                  agent: "codex",
                  agent_status: "idle",
                  revision: 1,
                  agent_session: {
                    source: "fixture",
                    agent: "codex",
                    kind: "id",
                    value: live.state.sessionId,
                  },
                },
                {
                  pane_id: "w1:p2",
                  terminal_id: "shell",
                  agent: null,
                  agent_session: null,
                  agent_status: "idle",
                  revision: 0,
                },
              ],
            },
          }
        : {
            process_info: {
              pane_id: "w1:p1",
              shell_pid: null,
              foreground_processes: [{ pid: foreground, name: "fixture" }],
            },
          },
    ),
  };
  const discovery = new CompositeDiscovery(native, () => read);
  const bindingId = randomUUID();
  const bind = vi.fn(async () => ({
    binding: { consumer_binding_id: bindingId, binding_epoch: 1 },
  }));
  const lease = vi.fn(async () => ({ lease: null }));
  const closeRelay = vi.fn(async () => {});
  const factory: RelayFactory = {
    start: vi.fn(async (session, operationId) => {
      expect(store.read().registrations[0].runtime.kind).toBe("herdr");
      return {
        api: { agents: { bind }, dispatch: { lease } } as unknown as TilaFacade,
        context: {
          ...session.context,
          run_id: operationId,
          run_role: "relay",
        } as RuntimeRunContext,
        close: closeRelay,
      };
    }),
    recover: vi.fn(async () => {}),
  };
  const connector = enabled
    ? new HostConnector(store, discovery, factory, {
        requireHerdrRegistration: () => {},
      })
    : new HostConnector(store, discovery, factory);
  const control = new ConnectorControl(store);
  cleanups.push(async () => {
    await connector.close();
    await control.close();
    rmSync(root, { recursive: true, force: true });
  });
  const target = {
    kind: "herdr" as const,
    socket: join(root, "fixture.sock"),
    paneId: "w1:p1",
  };
  const request = {
    action: "register" as const,
    key: live.state.key,
    expectedEpoch: 0,
    allowIdleStart: false,
    target,
  };
  return {
    root,
    store,
    live,
    native,
    read,
    discovery,
    factory,
    connector,
    control,
    target,
    request,
    bind,
    lease,
    effect,
    closeRelay,
    replaceSocket: () => {
      instance = "replaced-incarnation";
    },
    replaceTerminal: () => {
      terminal = "replaced-terminal";
    },
    replaceForeground: () => {
      foreground = 1;
    },
  };
}

it("routes authenticated inspection and gated registration through the production control path without effects", async () => {
  const f = fixture(false);
  await f.control.listen((request) => f.connector.request(request));
  expect(
    await controlRequest(f.store, {
      action: "inspect-herdr",
      key: f.live.state.key,
      target: f.target,
    }),
  ).toMatchObject({ eligibility: "eligible", support: { supported: false } });
  expect(f.store.read().registrations).toEqual([]);
  expect(f.factory.start).not.toHaveBeenCalled();
  f.native.discover.mockClear();
  expect(await controlRequest(f.store, f.request)).toMatchObject({
    code: "unsupported-capability",
  });
  expect(f.native.discover).not.toHaveBeenCalled();
  expect(f.bind).not.toHaveBeenCalled();
  expect(f.effect).not.toHaveBeenCalled();
});

// Sequential control round trips and process-identity checks need headroom under CI load.
it("persists verified association before relay creation, uses stable refs and accepts only exact repeats", async () => {
  const f = fixture();
  await f.control.listen((request) => f.connector.request(request));
  await controlRequest(f.store, f.request);
  const entry = f.store.read().registrations[0];
  expect(entry.runtime).toMatchObject({
    kind: "herdr",
    socket: f.target.socket,
    observation: { terminal_id: "fixture-terminal" },
  });
  await controlRequest(f.store, f.request);
  expect(f.factory.start).toHaveBeenCalledTimes(1);
  expect(f.bind).toHaveBeenCalledTimes(1);
  const restarted = new CompositeDiscovery(f.native, () => f.read);
  expect((await restarted.discover(entry.key, entry)).runtime).toEqual(
    entry.runtime,
  );
  await expect(
    controlRequest(f.store, { ...f.request, allowIdleStart: true }),
  ).rejects.toThrow();
  await expect(
    controlRequest(f.store, { ...f.request, expectedEpoch: 1 }),
  ).rejects.toThrow();
  await expect(
    controlRequest(f.store, { ...f.request, target: { kind: "standalone" } }),
  ).rejects.toThrow();
  await expect(
    controlRequest(f.store, {
      ...f.request,
      target: { ...f.target, paneId: "w1:p2" },
    }),
  ).rejects.toThrow();
  expect(f.bind).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(f.connector.status())).not.toMatch(
    /fixture-only|account_ref|fixture\.sock/,
  );
}, 15_000);

it.each([
  "socket",
  "terminal",
  "foreground",
  "account",
  "profile",
  "broker",
  "native-session",
])(
  "pauses %s replacement and closes only its scoped relay",
  async (replacement) => {
    const f = fixture();
    await f.connector.request(f.request);
    if (replacement === "socket") f.replaceSocket();
    if (replacement === "terminal") f.replaceTerminal();
    if (replacement === "foreground") f.replaceForeground();
    if (replacement === "account")
      f.live.evidence.account_ref = "changed-account";
    if (replacement === "profile") f.live.state.profile.revision++;
    if (replacement === "broker" && f.live.state.runtime)
      f.live.state.runtime.socket = "/replacement-broker";
    if (replacement === "native-session") f.live.state.sessionId = randomUUID();
    await f.connector.tick();
    expect(f.connector.status().registrations[0].state).toBe("paused");
    expect(f.closeRelay).toHaveBeenCalledTimes(1);
    expect(f.lease).not.toHaveBeenCalled();
    expect(f.effect).not.toHaveBeenCalled();
  },
);

it.each(["generation", "profile", "account", "run", "participant"])(
  "rejects %s replacement after native verification during Herdr I/O",
  async (replacement) => {
    const f = fixture();
    const original = f.read.request.bind(f.read);
    vi.mocked(f.read.request).mockImplementationOnce(async (method, params) => {
      const result = await original(method, params);
      if (replacement === "generation") f.live.state.generation = randomUUID();
      if (replacement === "profile") f.live.state.profile.revision++;
      if (replacement === "account")
        f.live.evidence.account_ref = "changed-account";
      if (replacement === "run") f.live.context.run_id = randomUUID();
      if (replacement === "participant")
        f.live.context.participant_id = "replacement";
      return result;
    });
    await expect(f.connector.request(f.request)).rejects.toThrow();
    expect(f.factory.start).not.toHaveBeenCalled();
    expect(f.bind).not.toHaveBeenCalled();
  },
);

it("rechecks after relay creation and retains lost bind intent without adopting a newer epoch", async () => {
  const f = fixture();
  const start = vi.mocked(f.factory.start).getMockImplementation();
  vi.mocked(f.factory.start).mockImplementationOnce(
    async (session, operation) => {
      const result = await start?.(session, operation);
      if (!result) throw new Error("Missing fixture relay");
      f.live.state.profile.revision++;
      return result;
    },
  );
  await expect(f.connector.request(f.request)).rejects.toThrow();
  expect(f.bind).not.toHaveBeenCalled();
  expect(f.closeRelay).toHaveBeenCalledTimes(1);
  const lost = fixture();
  lost.bind.mockRejectedValueOnce(
    new Error("Response lost after server commit"),
  );
  await expect(lost.connector.request(lost.request)).rejects.toThrow();
  const intent = lost.store.read().registrations[0];
  expect(intent.expectedEpoch).toBe(0);
  expect(intent.bindingEpoch).toBeUndefined();
  expect(intent.runtime.kind).toBe("herdr");
  await lost.connector.request(lost.request);
  expect(lost.bind).toHaveBeenCalledTimes(1);
});

it("refuses persistence failure before relay effects and prevents duplicate standalone ownership", async () => {
  const f = fixture();
  vi.spyOn(f.store, "write").mockImplementationOnce(() => {
    throw new Error("Fixture disk failure");
  });
  await expect(f.connector.request(f.request)).rejects.toThrow("disk failure");
  expect(f.factory.start).not.toHaveBeenCalled();
  expect(f.connector.ledger.registrations).toEqual([]);
  await f.connector.request(f.request);
  f.live.state.key = "b".repeat(64);
  await expect(
    f.connector.request({
      ...f.request,
      key: f.live.state.key,
      target: { kind: "standalone" },
    }),
  ).rejects.toThrow("already registered");
  expect(f.factory.start).toHaveBeenCalledTimes(1);
});

it("rechecks Herdr foreground during native pre-effect I/O", async () => {
  const f = fixture();
  const session = await f.discovery.discover(
    f.live.state.key,
    undefined,
    f.target,
  );
  f.replaceForeground();
  await expect(f.discovery.wake(session, randomUUID(), true)).rejects.toThrow(
    "foreground occupant",
  );
  expect(f.effect).not.toHaveBeenCalled();
});

it("retains the committed binding epoch and pauses replacement during bind I/O", async () => {
  const f = fixture();
  const original = f.bind.getMockImplementation();
  f.bind.mockImplementationOnce(async () => {
    const result = await original?.();
    if (!result) throw new Error("Fixture missing binding");
    f.live.evidence.account_ref = "replacement-account";
    return result;
  });
  await expect(f.connector.request(f.request)).rejects.toThrow();
  expect(f.store.read().registrations[0]).toMatchObject({
    bindingEpoch: 1,
    state: "paused",
    expectedEpoch: 0,
  });
  expect(f.closeRelay).toHaveBeenCalledTimes(1);
  expect(f.effect).not.toHaveBeenCalled();
});

it("startup inspection checks persisted associations without binding, wake, recovery or epoch adoption", async () => {
  const f = fixture();
  await f.connector.request(f.request);
  const before = f.store.read();
  f.bind.mockClear();
  vi.mocked(f.factory.start).mockClear();
  f.replaceTerminal();
  const report = await f.connector.request({
    action: "inspect-herdr-registrations",
  });
  expect(report).toMatchObject({
    support: { supported: false },
    registrations: [{ key: f.live.state.key, eligibility: "unavailable" }],
  });
  expect(f.store.read()).toEqual(before);
  expect(f.bind).not.toHaveBeenCalled();
  expect(f.factory.start).not.toHaveBeenCalled();
  expect(f.factory.recover).not.toHaveBeenCalled();
  expect(f.effect).not.toHaveBeenCalled();
});
