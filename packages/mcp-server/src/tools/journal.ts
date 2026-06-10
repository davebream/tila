import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TilaFacade } from "tila-sdk";
import { z } from "zod";
import { toMcpError } from "../errors";

export function registerJournalTools(
  server: McpServer,
  facade: TilaFacade,
  _projectId: string,
): void {
  const journal = facade.journal;

  server.tool(
    "tila_journal_list",
    "Query the project event journal. Returns journal entries in chronological order. Use to inspect execution history for coordination decisions.",
    {
      resource: z.string().optional().describe("Filter by entity ID"),
      kind: z
        .string()
        .optional()
        .describe(
          "Filter by event kind (e.g. 'entity.update', 'gate.resolve')",
        ),
      after_seq: z
        .number()
        .int()
        .optional()
        .describe("Return events after this sequence number"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .default(20)
        .describe("Maximum events to return"),
    },
    async ({ resource, kind, after_seq, limit }) => {
      try {
        const result = await journal.query({
          resource,
          kind,
          after_seq: after_seq !== undefined ? String(after_seq) : undefined,
          limit: String(limit),
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        throw toMcpError(err);
      }
    },
  );
}
