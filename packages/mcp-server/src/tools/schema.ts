import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TilaFacade } from "tila-sdk";
import { z } from "zod";
import { toMcpError } from "../errors";

export function registerSchemaTools(
  server: McpServer,
  facade: TilaFacade,
  _projectId: string,
): void {
  const schema = facade.schema;

  server.tool(
    "tila_schema_update",
    "Apply a new schema definition to the project. Pass the full TOML schema string. Returns the new version and a list of changes applied.",
    {
      definition: z.string().describe("Full TOML schema definition string"),
      strategy: z
        .enum(["relax", "force"])
        .optional()
        .describe("Migration strategy when destructive changes are detected"),
    },
    async ({ definition, strategy }) => {
      try {
        const result = await schema.apply(definition, strategy);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        throw toMcpError(err);
      }
    },
  );
}
