import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TilaClient } from "tila-sdk";
import { z } from "zod";
import { toMcpError } from "../errors";

export function registerGateTools(
  server: McpServer,
  client: TilaClient,
  projectId: string,
): void {
  const base = `/projects/${projectId}/gates`;

  server.tool(
    "tila_gate_create",
    "Create a coordination gate that blocks work on an entity until an external event occurs (CI pass, PR merge, human approval, timer, webhook). Requires a valid fencing token from tila_claim_acquire.",
    {
      resource: z.string().describe("Entity ID to gate"),
      await_type: z
        .enum(["ci", "pr", "timer", "human", "webhook"])
        .describe("Type of external event to wait for"),
      fence: z
        .number()
        .int()
        .describe(
          "Fencing token from tila_claim_acquire -- required for gate creation",
        ),
      timeout_at: z
        .number()
        .int()
        .optional()
        .describe(
          "Unix epoch milliseconds when the gate auto-resolves as timed_out",
        ),
      data: z
        .record(z.unknown())
        .optional()
        .describe("Arbitrary metadata for the gate (e.g. CI run URL)"),
    },
    async ({ resource, await_type, fence, timeout_at, data }) => {
      try {
        const result = await client.post(base, {
          resource,
          await_type,
          fence,
          timeout_at,
          data,
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        throw toMcpError(err);
      }
    },
  );

  server.tool(
    "tila_gate_resolve",
    "Resolve a pending gate, unblocking work on the associated entity. The entity becomes eligible for the ready set again.",
    {
      gate_id: z.string().describe("Gate ID to resolve (starts with 'gate-')"),
      resolution: z
        .string()
        .optional()
        .describe("Resolution reason (e.g. 'ci-passed', 'pr-merged')"),
    },
    async ({ gate_id, resolution }) => {
      try {
        const result = await client.post(`${base}/${gate_id}/resolve`, {
          resolution,
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        throw toMcpError(err);
      }
    },
  );

  server.tool(
    "tila_gate_cancel",
    "Cancel (delete) a pending gate, removing the coordination constraint. The entity becomes eligible for the ready set again if no other gates remain.",
    {
      gate_id: z.string().describe("Gate ID to cancel (starts with 'gate-')"),
    },
    async ({ gate_id }) => {
      try {
        const result = await client.delete(`${base}/${gate_id}`);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        throw toMcpError(err);
      }
    },
  );
}
