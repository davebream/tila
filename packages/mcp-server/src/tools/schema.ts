import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TilaFacade } from "tila-sdk";
import { z } from "zod";
import { toMcpError } from "../errors";
import { registerPrimitiveTool } from "../tool-registration";

export function registerSchemaTools(
  server: McpServer,
  facade: TilaFacade,
  _projectId: string,
): void {
  const schema = facade.schema;

  registerPrimitiveTool(
    server,
    "tila_schema_update",
    "Apply a new schema definition to the project. Pass the full TOML schema string. Returns the new version and a list of changes applied.",
    {
      expected_revision: z.number().int().nonnegative().optional(),
      reviewed_definition: z.string().optional(),
      idempotency_key: z.string().min(1).max(256).optional(),
      definition: z.string().describe("Full TOML schema definition string"),
      strategy: z
        .enum(["relax", "force"])
        .optional()
        .describe("Migration strategy when destructive changes are detected"),
    },
    async ({
      definition,
      strategy,
      expected_revision,
      reviewed_definition,
      idempotency_key,
    }) => {
      try {
        const options = {
          expected_revision,
          reviewed_definition,
          idempotency_key,
        };
        const result = Object.values(options).some(
          (value) => value !== undefined,
        )
          ? await schema.apply(definition, strategy, options)
          : await schema.apply(definition, strategy);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        throw toMcpError(err);
      }
    },
  );
  registerPrimitiveTool(
    server,
    "tila_schema_preview",
    "Preview configuration changes and obtain a revision and reviewed definition for a conditional apply.",
    { definition: z.string() },
    async ({ definition }) => {
      try {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(await schema.preview(definition)),
            },
          ],
        };
      } catch (err) {
        throw toMcpError(err);
      }
    },
  );
}
