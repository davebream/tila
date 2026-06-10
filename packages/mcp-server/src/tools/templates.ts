import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TilaFacade } from "tila-sdk";
import { z } from "zod";
import { toMcpError } from "../errors";

export function registerTemplateTools(
  server: McpServer,
  facade: TilaFacade,
  _projectId: string,
): void {
  const templates = facade.templates;

  server.tool(
    "tila_template_list",
    "List available entity templates from the project schema. Templates define reusable entity archetypes with preset fields and relationships.",
    {},
    async () => {
      try {
        const result = await templates.list();
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        throw toMcpError(err);
      }
    },
  );

  server.tool(
    "tila_template_instantiate",
    "Create new entities from a template. The template defines entity types, default fields, and relationships; variables are substituted at instantiation time.",
    {
      template: z.string().describe("Template name from tila_template_list"),
      id: z
        .string()
        .optional()
        .describe("Override the auto-generated root entity ID"),
      variables: z
        .record(z.unknown())
        .default({})
        .describe("Template variable substitutions"),
    },
    async ({ template, id, variables }) => {
      try {
        const result = await templates.instantiate({
          template_name: template,
          root_id: id ?? `T-${Date.now().toString(36)}`,
          vars: variables,
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
