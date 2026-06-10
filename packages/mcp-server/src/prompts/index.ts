import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TilaFacade } from "tila-sdk";
import { z } from "zod";

export function registerAllPrompts(
  server: McpServer,
  facade: TilaFacade,
  _projectId: string,
): void {
  server.prompt(
    "tila_status_report",
    "Generate a Markdown status report of the tila project: summary stats and ready-work list.",
    async () => {
      try {
        const [summary, ready] = await Promise.all([
          facade.summary.get(),
          facade.tasks.ready(),
        ]);

        const p = summary.project;
        const statusLines = Object.entries(p.status_counts)
          .map(([s, c]) => `  - ${s}: ${c}`)
          .join("\n");
        const readyLines =
          ready.entities.length > 0
            ? ready.entities
                .map(
                  (e: (typeof ready.entities)[number]) =>
                    `  - **${e.id}** (${e.type})${e.data.title ? `: ${e.data.title}` : ""}`,
                )
                .join("\n")
            : "  - (none)";
        const machines =
          p.online_machines.length > 0
            ? p.online_machines.join(", ")
            : "(none)";

        const text = `# tila Project Status

## Overview
- Total entities: ${p.entity_count}
- Active claims: ${p.active_claims}
- Ready for work: ${p.ready_count}
- Online machines: ${machines}

## Status Breakdown
${statusLines}

## Ready Work
${readyLines}`;

        return {
          messages: [
            {
              role: "user" as const,
              content: { type: "text" as const, text },
            },
          ],
        };
      } catch (err) {
        const msg =
          err instanceof Error
            ? err.message
            : "Failed to generate status report";
        return {
          messages: [
            {
              role: "user" as const,
              content: {
                type: "text" as const,
                text: `Error generating status report: ${msg}`,
              },
            },
          ],
        };
      }
    },
  );

  server.prompt(
    "tila_next_task",
    "Suggest the next task to work on from the ready-work set.",
    {
      type: z.string().optional().describe("Filter by entity type (optional)"),
    },
    async ({ type }) => {
      try {
        const ready = await facade.tasks.ready({ type });

        if (ready.entities.length === 0) {
          return {
            messages: [
              {
                role: "user" as const,
                content: {
                  type: "text" as const,
                  text: "No entities are currently ready for work. Check tila_summary for project status.",
                },
              },
            ],
          };
        }

        const next = ready.entities[0];
        const title = next.data.title ? ` "${next.data.title}"` : "";
        const text = `The next ready task is **${next.id}** (${next.type})${title}.

Use tila_claim_acquire to acquire a claim before starting work. The claim returns a fencing token needed for updates.

Data: ${JSON.stringify(next.data, null, 2)}`;

        return {
          messages: [
            {
              role: "user" as const,
              content: { type: "text" as const, text },
            },
          ],
        };
      } catch (err) {
        const msg =
          err instanceof Error ? err.message : "Failed to fetch ready work";
        return {
          messages: [
            {
              role: "user" as const,
              content: {
                type: "text" as const,
                text: `Error finding next task: ${msg}`,
              },
            },
          ],
        };
      }
    },
  );
}
