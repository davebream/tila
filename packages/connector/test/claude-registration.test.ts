import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import {
  type ProfileStore,
  SessionStore,
  processIdentity,
} from "@tila/client-lifecycle";
import type {
  CredentialProfile,
  LifecycleState,
  RuntimeRunContext,
} from "@tila/schemas";
import type { TilaFacade } from "tila-sdk";
import { afterEach, expect, it, vi } from "vitest";
import { HostConnector, type RelayFactory } from "../src/connector";
import { StandaloneDiscovery } from "../src/discovery";
import { ConnectorStore } from "../src/store";

const mocked = vi.hoisted(() => ({ connect: vi.fn(), directory: "" }));
vi.mock("@tila/client-lifecycle", async (original) => {
  const actual = await original<typeof import("@tila/client-lifecycle")>();
  const { workerProcessAlive } = await import("./fixtures/worker-process");
  return {
    ...actual,
    processAlive: workerProcessAlive(actual),
    connectRuntimeBroker: mocked.connect,
  };
});
// Only redirect the existing protected-socket guard to this run-owned fixture directory.
vi.mock("../src/claude", async (original) => {
  const actual = await original<typeof import("../src/claude")>();
  return {
    ...actual,
    validateClaudeEndpoint: (
      endpoint: Parameters<typeof actual.validateClaudeEndpoint>[0],
    ) => actual.validateClaudeEndpoint(endpoint, mocked.directory),
    wakeClaude: (
      endpoint: Parameters<typeof actual.wakeClaude>[0],
      nonce: string,
      options: Parameters<typeof actual.wakeClaude>[2],
    ) =>
      actual.wakeClaude(endpoint, nonce, {
        ...options,
        directory: mocked.directory,
      }),
  };
});
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  mocked.connect.mockReset();
});
async function fixture() {
  const root = mkdtempSync("/tmp/tila-claude-register-");
  mocked.directory = root;
  const socket = join(root, "peer.sock");
  const writes = vi.fn();
  let received!: () => void;
  const notice = new Promise<void>((resolve) => {
    received = resolve;
  });
  const peer = createServer((connection) => {
    connection.on("data", writes);
    connection.on("end", received);
  });
  await new Promise<void>((resolve) => peer.listen(socket, resolve));
  chmodSync(socket, 0o600);
  const store = new ConnectorStore(join(root, "connector"));
  const sessions = new SessionStore(join(root, "sessions"));
  const acting = randomUUID();
  const state: LifecycleState & {
    nativeMessaging: NonNullable<LifecycleState["nativeMessaging"]>;
  } = {
    version: 1,
    key: "a".repeat(64),
    namespace: '["https://tila.test","project"]',
    client: "claude-code",
    sessionId: randomUUID(),
    profile: { id: "claude-fixture", revision: 1 },
    participantId: "fixture-participant",
    runtime: {
      socket: "/fixture-broker",
      capability: "fixture-only",
      runId: acting,
    },
    nativeMessaging: { socket, token: "fixture-peer-token", idle: true },
    cwd: root,
    environment: { client_name: "claude-code" },
    generation: randomUUID(),
    owner: processIdentity(process.pid),
    worker: null,
    phase: "active",
    observedSeq: 0,
    offeredSeq: 0,
    lastHeartbeat: null,
    degraded: null,
    reentryPending: false,
    pendingHandoff: null,
    handoffSaved: false,
    cursorSaved: false,
    releaseClaims: [],
  };
  sessions.write(state);
  const profile = {
    id: "claude-fixture",
    revision: 1,
    harness: "claude-code",
    launcher: "/fixture/claude",
    config_dir: root,
    credential_store: "auto",
    account_ref: "fixture-account",
    env_allowlist: [],
  } as CredentialProfile;
  const profiles = {
    root,
    get: vi.fn(() => structuredClone(profile)),
    verify: vi.fn(async () => ({
      profile_id: profile.id,
      profile_revision: 1,
      account_ref: profile.account_ref,
      verification: "declared" as const,
    })),
  } as unknown as ProfileStore;
  const context = {
    run_id: acting,
    run_role: "acting",
    agent_id: "claude-worker",
    enrollment_id: randomUUID(),
    project_id: "project",
    instance_id: randomUUID(),
    participant_id: state.participantId,
    principal_id: "fixture-principal",
  } as RuntimeRunContext;
  mocked.connect.mockResolvedValue({
    deployment: "https://tila.test",
    context,
  });
  const bindingId = randomUUID();
  const closeRelay = vi.fn(async () => {});
  const bind = vi.fn(async () => ({
    binding: { consumer_binding_id: bindingId, binding_epoch: 1 },
  }));
  let token = randomUUID();
  const metadata = {
    binding: { consumer_binding_id: bindingId, binding_epoch: 1 },
    attempt: { outcome: "leased", created_at: 0 },
    server_now: Date.now(),
    outbox: { lease_token: token },
    deliveries: [],
  };
  const lease = vi.fn(async () => {
    token = randomUUID();
    metadata.outbox.lease_token = token;
    metadata.attempt = { outcome: "leased", created_at: Date.now() };
    return {
      lease: {
        lease_token: token,
        lease_until: Date.now() + 30_000,
        publish_gen: 1,
        consumer_binding_id: bindingId,
        binding_epoch: 1,
        allow_idle_start: false,
        native_session_ref: {
          host_ref: connector.ledger.hostRef,
          session_id: state.sessionId,
          profile_id: profile.id,
        },
      },
    };
  });
  const report = vi.fn(async (_agent: string, input: { outcome: string }) => {
    metadata.attempt.outcome = input.outcome;
    return {};
  });
  const factory: RelayFactory = {
    start: vi.fn(async (_session, operationId) => ({
      api: {
        agents: { bind },
        dispatch: { lease, status: vi.fn(async () => metadata), report },
      } as unknown as TilaFacade,
      context: { ...context, run_id: operationId, run_role: "relay" },
      close: closeRelay,
    })),
    recover: vi.fn(async () => {}),
  };
  const discovery = new StandaloneDiscovery(
    sessions,
    profiles,
    join(root, "protocols"),
  );
  const connector: HostConnector = new HostConnector(store, discovery, factory);
  cleanups.push(async () => {
    await connector.close();
    await new Promise<void>((resolve) => peer.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  });
  await connector.request({
    action: "register",
    key: state.key,
    expectedEpoch: 0,
    allowIdleStart: false,
  });
  return {
    connector,
    state,
    sessions,
    store,
    writes,
    notice,
    factory,
    closeRelay,
    bind,
    report,
    root,
  };
}

it("keeps the same Claude relay and epoch through idle to busy to idle and performs no busy write", async () => {
  const f = await fixture();
  const original = f.store.read().registrations[0];
  f.sessions.write({
    ...f.state,
    nativeMessaging: { ...f.state.nativeMessaging, idle: false },
  });
  await f.connector.tick();
  expect(f.connector.status().registrations[0]).toMatchObject({
    state: "active",
    bindingId: original.bindingId,
    bindingEpoch: original.bindingEpoch,
  });
  expect(f.writes).not.toHaveBeenCalled();
  expect(f.closeRelay).not.toHaveBeenCalled();
  expect(f.report).toHaveBeenCalledWith(
    "claude-worker",
    expect.objectContaining({ outcome: "deferred" }),
  );
  f.sessions.write(f.state);
  await f.connector.tick();
  await f.notice;
  expect(f.writes).toHaveBeenCalled();
  expect(f.factory.start).toHaveBeenCalledTimes(1);
  expect(f.bind).toHaveBeenCalledTimes(1);
  expect(f.closeRelay).not.toHaveBeenCalled();
  expect(f.store.read().registrations[0].identity).toEqual(original.identity);
  expect(f.connector.status().registrations[0]).toMatchObject({
    state: "active",
    bindingId: original.bindingId,
    bindingEpoch: original.bindingEpoch,
  });
});

it.each(["socket", "token", "token-absence"])(
  "rejects Claude %s replacement while retaining binding evidence",
  async (field) => {
    const f = await fixture();
    const endpoint = { ...f.state.nativeMessaging };
    if (field === "socket") endpoint.socket = join(f.root, "replacement.sock");
    if (field === "token") endpoint.token = "replacement-fixture-token";
    if (field === "token-absence") endpoint.token = undefined;
    f.sessions.write({ ...f.state, nativeMessaging: endpoint });
    await f.connector.tick();
    expect(f.connector.status().registrations[0]).toMatchObject({
      state: "paused",
      bindingEpoch: 1,
    });
    expect(f.writes).not.toHaveBeenCalled();
    expect(f.closeRelay).toHaveBeenCalledTimes(1);
    expect(f.bind).toHaveBeenCalledTimes(1);
  },
);
