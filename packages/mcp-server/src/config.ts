import {
  SessionStore,
  brokerReference,
  clientOwner,
  connectRuntimeBroker,
  sessionKey,
} from "@tila/client-lifecycle";
import { LifecycleClientSchema } from "@tila/schemas";
import { TokenProviderError, assertRuntimeContext } from "tila-sdk";

export interface McpServerConfig {
  mode: "remote";
  apiUrl: string;
  projectId: string;
  resolveRun(
    meta?: Record<string, unknown>,
  ): ReturnType<typeof connectRuntimeBroker>;
}

/** MCP accepts only a managed run or an installed, unambiguous host mapping. */
export async function resolveServerConfig(): Promise<McpServerConfig> {
  for (const key of [
    "TILA_API_TOKEN",
    "TILA_TOKEN",
    "TILA_DB_PATH",
    "TILA_ARTIFACTS_PATH",
  ]) {
    if (process.env[key])
      throw new TokenProviderError(
        "runtime-auth-required",
        `${key} is unsupported by MCP. Use tila machine enroll and tila mcp init, or tila run exec.`,
      );
  }
  if (process.env.TILA_MODE === "local" || process.env.TILA_BACKEND === "local")
    throw new TokenProviderError(
      "runtime-auth-required",
      "MCP requires a shared project runtime; private SQLite mode was removed",
    );
  if (process.env.TILA_RUN_SOCKET || process.env.TILA_RUN_CAPABILITY) {
    const reference = brokerReference();
    const initial = await connectRuntimeBroker(reference);
    if (
      (process.env.TILA_PROJECT_ID &&
        process.env.TILA_PROJECT_ID !== initial.context.project_id) ||
      (process.env.TILA_API_URL &&
        new URL(process.env.TILA_API_URL).origin !== initial.deployment) ||
      (process.env.TILA_PARTICIPANT_ID &&
        process.env.TILA_PARTICIPANT_ID !== initial.context.participant_id)
    )
      throw new TokenProviderError(
        "runtime-binding-mismatch",
        "MCP configuration conflicts with its run",
      );
    return {
      mode: "remote",
      apiUrl: initial.deployment,
      projectId: initial.context.project_id,
      resolveRun: async () => {
        const current = await connectRuntimeBroker(reference);
        assertRuntimeContext(current.context, initial.context);
        return current;
      },
    };
  }
  const client = LifecycleClientSchema.safeParse(
    process.env.TILA_LIFECYCLE_CLIENT,
  );
  const apiUrl = process.env.TILA_API_URL;
  const projectId = process.env.TILA_PROJECT_ID;
  if (!client.success || client.data === "cli" || !apiUrl || !projectId)
    throw new TokenProviderError(
      "runtime-auth-required",
      "MCP needs a run broker or supported session hooks. Run tila mcp init.",
    );
  const namespace = JSON.stringify([apiUrl.replace(/\/+$/, ""), projectId]);
  const store = new SessionStore();
  const ceilings = new Map<string, import("@tila/schemas").RuntimeContext>();
  return {
    mode: "remote",
    apiUrl,
    projectId,
    async resolveRun(meta) {
      let state: import("@tila/schemas").LifecycleState | null = null;
      if (client.data === "codex") {
        const session = meta?.sessionId ?? meta?.threadId;
        if (
          typeof session !== "string" ||
          (meta?.sessionId &&
            meta?.threadId &&
            meta.sessionId !== meta.threadId)
        )
          throw new TokenProviderError(
            "runtime-session-unavailable",
            "This shared client must supply unambiguous per-request session metadata. Use one MCP process per tila run exec session otherwise.",
          );
        state = store.read(sessionKey(namespace, client.data, session));
      } else {
        const owner = clientOwner(client.data);
        const matches = store
          .list()
          .filter(
            (entry) =>
              entry.namespace === namespace &&
              entry.client === client.data &&
              entry.phase === "active" &&
              owner &&
              entry.owner?.pid === owner.pid &&
              entry.owner.started === owner.started,
          );
        if (matches.length === 1) state = matches[0];
      }
      if (!state || state.phase !== "active" || !state.runtime)
        throw new TokenProviderError(
          "runtime-session-unavailable",
          "No active run is mapped to this client session",
        );
      const run = await connectRuntimeBroker(state.runtime);
      if (
        run.context.run_id !== state.runtime.runId ||
        run.context.participant_id !== state.participantId ||
        run.context.project_id !== projectId ||
        run.deployment !== new URL(apiUrl).origin
      )
        throw new TokenProviderError(
          "runtime-binding-mismatch",
          "Session mapping does not match its runtime",
        );
      const initial = ceilings.get(state.runtime.runId);
      if (initial) assertRuntimeContext(run.context, initial);
      else {
        if (ceilings.size >= 1000)
          throw new TokenProviderError(
            "runtime-session-unavailable",
            "Restart the shared MCP process to clear ended session bindings",
          );
        ceilings.set(state.runtime.runId, run.context);
      }
      return run;
    },
  };
}
