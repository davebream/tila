import { spawn } from "node:child_process";
import {
  ProfileStore,
  SessionStore,
  processIdentity,
  profileEnvironment,
} from "@tila/client-lifecycle";
import {
  ConnectorStore,
  NativeLaunch,
  StandaloneDiscovery,
} from "@tila/connector";
import { CREDENTIAL_PRESETS } from "@tila/schemas";
import { cliInvocation } from "./lifecycle-runtime";
import { runtimeSelection } from "./runtime";

export async function openConnectorSession(args: {
  agent: string;
  profile: string;
  session: string;
  operation: string;
}) {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error(
      "Standalone restoration requires an attended terminal; unattended restoration is unsupported",
    );
  const profiles = new ProfileStore();
  const profile = profiles.get(args.profile);
  const selection = await runtimeSelection();
  const sessions = new SessionStore();
  const discovery = new StandaloneDiscovery(sessions, profiles);
  const launch = new NativeLaunch(new ConnectorStore(), profiles, {
    async discover(request) {
      for (const state of sessions.list()) {
        if (
          state.namespace !== request.namespace ||
          state.sessionId !== request.sessionId ||
          state.profile?.id !== request.profile ||
          state.profile.revision !== request.profileRevision ||
          state.phase !== "active"
        )
          continue;
        const current = await discovery.discover(state.key);
        if (current.context.agent_id !== request.agent)
          throw new Error("Native session belongs to another agent");
        return state.key;
      }
      return null;
    },
    async spawn(request) {
      const [command, ...invocation] = cliInvocation();
      const capabilities = [
        ...new Set([
          ...CREDENTIAL_PRESETS.worker.capabilities,
          "conversations:read",
          "conversations:publish",
          "inbox:consume",
        ]),
      ].join(",");
      const nativeArgs =
        profile.harness === "codex"
          ? ["resume", request.sessionId]
          : ["--resume", request.sessionId];
      const env = profileEnvironment(profile);
      env.TILA_HOME = profiles.root;
      const child = spawn(
        command,
        [
          ...invocation,
          "run",
          "exec",
          "--instance",
          selection.deployment,
          "--project",
          selection.projectId,
          "--agent",
          request.agent,
          "--profile",
          profile.id,
          "--capabilities",
          capabilities,
          "--",
          profile.launcher,
          ...nativeArgs,
        ],
        { env, stdio: "inherit" },
      );
      const exited = new Promise<number | null>((resolve, reject) => {
        child.once("exit", resolve);
        child.once("error", reject);
      });
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
      const identity = child.pid ? processIdentity(child.pid) : null;
      if (!identity) {
        child.kill();
        await exited.catch(() => {});
        throw new Error("Cannot identify native launch process");
      }
      return { process: identity, exited };
    },
  });
  try {
    return await launch.open({
      operationId: args.operation,
      agent: args.agent,
      profile: profile.id,
      profileRevision: profile.revision,
      namespace: JSON.stringify([selection.deployment, selection.projectId]),
      sessionId: args.session,
    });
  } finally {
    discovery.close();
  }
}
