import { join } from "node:path";
import {
  ProfileStore,
  SessionStore,
  connectRuntimeBroker,
  processAlive,
} from "@tila/client-lifecycle";
import {
  type CapabilityReport,
  type CredentialProfile,
  type LifecycleState,
  LifecycleStateSchema,
  type ProfileEvidence,
  type RuntimeRunContext,
} from "@tila/schemas";
import { type WakeOutcome, validateClaudeEndpoint, wakeClaude } from "./claude";
import {
  type CodexCapabilities,
  CodexProxy,
  codexCapabilities,
  codexThread,
} from "./codex";
import { wakeCodex } from "./codex";
import { type Registration, readPrivate } from "./store";

export interface DiscoveredSession {
  state: LifecycleState & {
    owner: NonNullable<LifecycleState["owner"]>;
    profile: NonNullable<LifecycleState["profile"]>;
  };
  context: RuntimeRunContext;
  deployment: string;
  profile: CredentialProfile;
  evidence: ProfileEvidence;
  capabilities: CapabilityReport;
  mechanism: "native-peer" | "native-queue";
}
export interface SessionDiscovery {
  discover(key: string, expected?: Registration): Promise<DiscoveredSession>;
  wake(
    session: DiscoveredSession,
    nonce: string,
    allowIdleStart: boolean,
  ): Promise<WakeOutcome>;
  close(): void;
}
export class StandaloneDiscovery implements SessionDiscovery {
  private observers = new Map<
    string,
    { rpc: CodexProxy; capabilities: CodexCapabilities }
  >();
  constructor(
    readonly sessions = new SessionStore(),
    readonly profiles = new ProfileStore(),
    readonly protocolRoot = join(profiles.root, "connector", "protocols"),
  ) {}
  async discover(
    key: string,
    expected?: Registration,
  ): Promise<DiscoveredSession> {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("Invalid lifecycle key");
    const state = LifecycleStateSchema.parse(
      JSON.parse(readPrivate(join(this.sessions.root, `${key}.json`))),
    );
    if (
      state.key !== key ||
      state.phase !== "active" ||
      !state.owner ||
      !processAlive(state.owner) ||
      !state.profile ||
      !state.runtime ||
      state.client === "cli"
    )
      throw new Error(
        "A live, profiled native session with an acting run is required",
      );
    if (
      expected &&
      (state.generation !== expected.generation ||
        state.owner.pid !== expected.owner.pid ||
        state.owner.started !== expected.owner.started ||
        state.profile.id !== expected.profile.id ||
        state.profile.revision !== expected.profile.revision ||
        state.runtime.runId !== expected.actingRunId ||
        state.namespace !== expected.namespace)
    )
      throw new Error("Discovered session occupant changed");
    const profile = this.profiles.get(state.profile.id, state.profile.revision);
    if (profile.harness !== state.client)
      throw new Error("Profile harness mismatch");
    let evidence: ProfileEvidence;
    const connected = await connectRuntimeBroker(state.runtime);
    if (
      connected.context.run_id !== state.runtime.runId ||
      connected.context.run_role !== "acting" ||
      !connected.context.agent_id ||
      !connected.context.enrollment_id ||
      connected.context.participant_id !== state.participantId ||
      state.namespace !==
        JSON.stringify([connected.deployment, connected.context.project_id])
    )
      throw new Error("Discovered run does not match the native session");
    if (expected && connected.context.agent_id !== expected.agent)
      throw new Error("Agent identity changed");
    const capabilities: CapabilityReport = {
      protocol: 1,
      adapter_version: "1",
      capabilities: {
        "io.tila/body-free-notice": true,
        "io.tila/native-queue": false,
        "io.tila/draft-preservation": false,
      },
    };
    if (profile.harness === "claude-code") {
      evidence = await this.profiles.verify(profile.id, profile.revision);
      if (!state.nativeMessaging)
        throw new Error(
          "Claude messaging discovery is unavailable; restart with SessionStart hooks",
        );
      validateClaudeEndpoint(state.nativeMessaging);
      capabilities.capabilities["io.tila/native-peer"] = true;
    } else {
      const id = `${profile.id}:${profile.revision}`;
      let observer = this.observers.get(id);
      if (!observer) {
        observer = {
          rpc: new CodexProxy(profile),
          capabilities: codexCapabilities(profile, this.protocolRoot),
        };
        this.observers.set(id, observer);
      }
      const rpc = observer.rpc;
      evidence = await this.profiles.verify(
        profile.id,
        profile.revision,
        async () => {
          const response = (await rpc.request("account/read", {
            refreshToken: false,
          })) as { account?: { type?: string; email?: string } };
          return response.account?.type === "chatgpt"
            ? (response.account.email ?? null)
            : null;
        },
      );
      const native = await codexThread(observer.rpc, state.sessionId);
      if (!["idle", "active"].includes(native.state))
        throw new Error("Native Codex session is not live");
      capabilities.capabilities["io.tila/idle-start"] =
        observer.capabilities.start;
      capabilities.capabilities["io.tila/urgent-steer"] =
        observer.capabilities.steer;
    }
    // Re-read after external I/O: replacement cannot inherit a completed verification.
    const current = LifecycleStateSchema.parse(
      JSON.parse(readPrivate(join(this.sessions.root, `${key}.json`))),
    );
    if (
      current.generation !== state.generation ||
      current.phase !== "active" ||
      current.runtime?.runId !== state.runtime.runId ||
      current.namespace !== state.namespace ||
      JSON.stringify(current.profile) !== JSON.stringify(state.profile) ||
      JSON.stringify(current.owner) !== JSON.stringify(state.owner) ||
      !processAlive(state.owner)
    )
      throw new Error("Session changed during discovery");
    return {
      state: current as DiscoveredSession["state"],
      context: connected.context,
      deployment: connected.deployment,
      profile,
      evidence,
      capabilities,
      mechanism:
        profile.harness === "claude-code" ? "native-peer" : "native-queue",
    };
  }
  async wake(
    session: DiscoveredSession,
    nonce: string,
    allowIdleStart: boolean,
  ): Promise<WakeOutcome> {
    if (session.profile.harness === "claude-code") {
      if (!session.state.nativeMessaging) return "rejected";
      return wakeClaude(session.state.nativeMessaging, nonce);
    }
    const observer = this.observers.get(
      `${session.profile.id}:${session.profile.revision}`,
    );
    if (!observer) return "rejected";
    return wakeCodex(
      observer.rpc,
      observer.capabilities,
      session.state.sessionId,
      nonce,
      { allowIdleStart, urgent: false },
    );
  }
  close(): void {
    for (const observer of this.observers.values()) observer.rpc.close();
    this.observers.clear();
  }
}
