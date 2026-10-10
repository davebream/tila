import { connectRuntimeBroker } from "@tila/client-lifecycle";
import type { RelayFactory } from "@tila/connector";
import { createTila } from "tila-sdk";
import { enrolledRuntimeClient, startEnrolledRun } from "./runtime";

export const relayFactory: RelayFactory = {
  async start(session, operationId) {
    const selection = {
      deployment: session.deployment,
      projectId: session.context.project_id,
    };
    const managed = await startEnrolledRun(
      selection,
      {
        role: "participant",
        capabilities: ["dispatch:relay", "agent-bindings:attach"],
      },
      { agent_id: session.context.agent_id ?? undefined, run_role: "relay" },
      operationId,
    );
    try {
      const connected = await connectRuntimeBroker(managed.reference);
      const api = await createTila(
        {
          backend: "cloudflare",
          project_id: selection.projectId,
          worker_url: selection.deployment,
          schema_version: 0,
          tila_version: "0.4.0",
          created_at: new Date(0).toISOString(),
        },
        connected.provider,
        { participantId: connected.context.participant_id, timeoutMs: 5000 },
      );
      return {
        api,
        context: connected.context,
        async close() {
          api.close();
          await managed.broker.close();
        },
      };
    } catch (error) {
      await managed.broker.close();
      throw error;
    }
  },
  async recover(entry) {
    const [deployment, projectId] = JSON.parse(entry.namespace);
    if (typeof deployment !== "string" || typeof projectId !== "string")
      throw new Error("Invalid discovery namespace");
    const { api } = await enrolledRuntimeClient({ deployment, projectId });
    const old = (await api.runs()).runs.find(
      (run) => run.run_id === entry.relayOperationId,
    );
    if (!old) return;
    if (old.run_role !== "relay" || old.agent_id !== entry.agent)
      throw new Error("Recovery cannot close another run");
    await api.close(old.run_id);
  },
};
