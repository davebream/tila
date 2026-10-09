import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  type ProfileStore,
  SessionStore,
  processIdentity,
} from "@tila/client-lifecycle";
import type { CredentialProfile, LifecycleState } from "@tila/schemas";
import { afterEach, expect, it, vi } from "vitest";
import { StandaloneDiscovery } from "../src/discovery";

const mocked = vi.hoisted(() => ({
  connect: vi.fn(),
  account: "one@example.test",
  native: "native-session",
  proxies: 0,
}));
vi.mock("@tila/client-lifecycle", async (original) => ({
  ...(await original<typeof import("@tila/client-lifecycle")>()),
  connectRuntimeBroker: mocked.connect,
}));
vi.mock("../src/codex", () => ({
  CodexProxy: class {
    constructor() {
      mocked.proxies++;
    }
    async request() {
      return { account: { type: "chatgpt", email: mocked.account } };
    }
    close() {}
  },
  codexCapabilities: () => ({ start: true, steer: true, queue: false }),
  codexThread: async (_rpc: unknown, id: string) => {
    if (id !== mocked.native) throw new Error("Native session mismatch");
    return { state: "idle" };
  },
  wakeCodex: vi.fn(),
}));
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
  mocked.connect.mockReset();
  mocked.account = "one@example.test";
  mocked.proxies = 0;
});
function setup() {
  const root = mkdtempSync("/tmp/tila-discovery-");
  roots.push(root);
  const sessions = new SessionStore(join(root, "sessions"));
  const runId = randomUUID();
  const state: LifecycleState = {
    version: 1,
    key: "a".repeat(64),
    namespace: '["https://tila.test","project"]',
    client: "codex",
    sessionId: mocked.native,
    profile: { id: "one", revision: 1 },
    participantId: "participant",
    runtime: { socket: "/tmp/fixture-broker", capability: "private", runId },
    cwd: root,
    environment: { client_name: "codex" },
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
  const context = {
    run_id: runId,
    run_role: "acting",
    agent_id: "worker",
    enrollment_id: randomUUID(),
    project_id: "project",
    participant_id: "participant",
  };
  mocked.connect.mockResolvedValue({
    deployment: "https://tila.test",
    context,
  });
  const profile = {
    id: "one",
    revision: 1,
    harness: "codex",
    config_dir: root,
  } as CredentialProfile;
  const verify = vi.fn(
    async (
      _id: string,
      _revision: number,
      read: (profile: CredentialProfile) => Promise<string | null>,
    ) => {
      if ((await read(profile)) !== "one@example.test")
        throw new Error("Profile account changed");
      return {
        profile_id: "one",
        profile_revision: 1,
        account_ref: "redacted",
        verification: "declared",
      };
    },
  );
  const profiles = {
    get: () => profile,
    verify,
    root,
  } as unknown as ProfileStore;
  return {
    sessions,
    state,
    context,
    discovery: new StandaloneDiscovery(sessions, profiles, root),
    verify,
  };
}
it("shares one observer per profile and rejects account crossover and forged run role", async () => {
  const f = setup();
  await f.discovery.discover(f.state.key);
  await f.discovery.discover(f.state.key);
  expect(mocked.proxies).toBe(1);
  mocked.account = "two@example.test";
  await expect(f.discovery.discover(f.state.key)).rejects.toThrow(
    "account changed",
  );
  mocked.account = "one@example.test";
  f.context.run_role = "relay";
  await expect(f.discovery.discover(f.state.key)).rejects.toThrow(
    "does not match",
  );
  f.discovery.close();
});
it("rejects reused PIDs before attaching and detects replacement during external verification", async () => {
  const f = setup();
  const owner = f.state.owner;
  if (!owner) throw new Error("Test process identity unavailable");
  f.sessions.write({
    ...f.state,
    owner: { ...owner, started: "different process start" },
  });
  await expect(f.discovery.discover(f.state.key)).rejects.toThrow(
    "live, profiled",
  );
  expect(mocked.connect).not.toHaveBeenCalled();
  f.sessions.write(f.state);
  f.verify.mockImplementationOnce(async () => {
    f.sessions.write({ ...f.state, generation: randomUUID() });
    return {
      profile_id: "one",
      profile_revision: 1,
      account_ref: "redacted",
      verification: "declared",
    };
  });
  await expect(f.discovery.discover(f.state.key)).rejects.toThrow(
    "changed during discovery",
  );
  f.discovery.close();
});
