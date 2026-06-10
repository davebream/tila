import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TilaFacade } from "tila-sdk";
import { z } from "zod";
import { toMcpError } from "../errors";

function isCompatAliasEnabled(): boolean {
  const val = process.env.TILA_MCP_COMPAT_ALIASES ?? "";
  return val.toLowerCase() === "1" || val.toLowerCase() === "true";
}

export function registerClaimTools(
  server: McpServer,
  facade: TilaFacade,
  _projectId: string,
): void {
  const claims = facade.claims;

  // Shared handler bodies (extracted so canonical and alias registrations share one impl)
  async function acquireHandler({
    resource,
    mode,
    ttl_ms,
  }: {
    resource: string;
    mode: "exclusive" | "shared";
    ttl_ms: number;
  }) {
    try {
      const result = await claims.acquire(resource, mode, ttl_ms);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
      };
    } catch (err) {
      throw toMcpError(err);
    }
  }

  async function releaseHandler({
    resource,
    fence,
  }: {
    resource: string;
    fence: number;
  }) {
    try {
      const result = await claims.release(resource, fence);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
      };
    } catch (err) {
      throw toMcpError(err);
    }
  }

  const acquireSchema = {
    resource: z.string().describe("Task ID to claim"),
    mode: z
      .enum(["exclusive", "shared"])
      .default("exclusive")
      .describe("Claim mode"),
    ttl_ms: z
      .number()
      .int()
      .positive()
      .default(300000)
      .describe("Time-to-live in milliseconds (default: 5 minutes)"),
  };

  const releaseSchema = {
    resource: z.string().describe("Task ID whose claim to release"),
    fence: z.number().int().describe("Fencing token from tila_claim_acquire"),
  };

  // Canonical tools (always registered)
  server.tool(
    "tila_claim_acquire",
    "Acquire an exclusive or shared claim on a task. Returns a fencing token and expiration time. The fencing token is REQUIRED for subsequent tila_task_update, tila_claim_release, and tila_gate_create calls.",
    acquireSchema,
    acquireHandler,
  );

  server.tool(
    "tila_claim_release",
    "Release an active claim on a task. Requires the fencing token returned by tila_claim_acquire.",
    releaseSchema,
    releaseHandler,
  );

  server.tool(
    "tila_claim_list",
    "List all active claims in the project. Returns claim resource IDs, owners, modes, expiration times, and fencing tokens.",
    {},
    async () => {
      try {
        const result = await claims.list();
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        throw toMcpError(err);
      }
    },
  );

  // Compat aliases — only registered when TILA_MCP_COMPAT_ALIASES is truthy
  if (isCompatAliasEnabled()) {
    server.tool(
      "tila_task_claim",
      "[DEPRECATED] Use tila_claim_acquire instead. Acquire an exclusive or shared claim on a task.",
      acquireSchema,
      acquireHandler,
    );

    server.tool(
      "tila_task_release",
      "[DEPRECATED] Use tila_claim_release instead. Release an active claim on a task.",
      releaseSchema,
      releaseHandler,
    );
  }
}
