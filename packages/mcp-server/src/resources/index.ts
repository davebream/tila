import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TilaSchemaTomlSchema } from "@tila/schemas";
import { parse } from "smol-toml";
import type { TilaClient } from "tila-sdk";
import { toMcpError } from "../errors";

/**
 * Register opt-in record resources based on mcp_resource = true in the project schema.
 * Fetches the schema at startup; failure is non-fatal (server starts without record resources).
 */
async function registerRecordResources(
  server: McpServer,
  client: TilaClient,
  projectId: string,
): Promise<void> {
  try {
    const schemaResult = await client.get<{
      ok: boolean;
      schema: { definition: string } | null;
    }>(`/projects/${projectId}/schema`);

    const toml = schemaResult?.schema?.definition;
    if (!toml) return;

    const parsed = TilaSchemaTomlSchema.safeParse(parse(toml));
    if (!parsed.success) return;

    const schema = parsed.data;

    for (const [type, def] of Object.entries(schema.records ?? {})) {
      if (!def.mcp_resource) continue;

      const template = new ResourceTemplate(`tila://records/${type}/{key}`, {
        list: undefined,
      });

      server.resource(
        `record-${type}`,
        template,
        {
          description: `Record of type "${type}" -- opt-in MCP resource (mcp_resource = true in schema)`,
          mimeType: "application/json",
        },
        async (uri, variables) => {
          const rawKey = variables.key as string;
          try {
            const result = await client.get(
              `/projects/${projectId}/records/${type}/${rawKey}`,
            );
            return {
              contents: [
                {
                  uri: uri.href,
                  mimeType: "application/json",
                  text: JSON.stringify(result),
                },
              ],
            };
          } catch (err) {
            throw toMcpError(err);
          }
        },
      );
    }
  } catch {
    // Schema fetch failure is non-fatal -- server starts without record resources.
    // Errors are swallowed intentionally per design decision.
  }
}

export async function registerAllResources(
  server: McpServer,
  client: TilaClient,
  projectId: string,
): Promise<void> {
  const projectBase = `/projects/${projectId}`;

  server.resource(
    "project-summary",
    "tila://project/summary",
    {
      description:
        "Project summary: entity counts, status breakdown, active claims, ready count, online machines",
      mimeType: "application/json",
    },
    async (uri) => {
      try {
        const result = await client.get(`${projectBase}/summary`);
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "application/json",
              text: JSON.stringify(result),
            },
          ],
        };
      } catch (err) {
        throw toMcpError(err);
      }
    },
  );

  server.resource(
    "project-ready",
    "tila://project/ready",
    {
      description:
        "Entities ready for work -- no open blockers, no pending gates",
      mimeType: "application/json",
    },
    async (uri) => {
      try {
        const result = await client.get(`${projectBase}/entities/ready`);
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "application/json",
              text: JSON.stringify(result),
            },
          ],
        };
      } catch (err) {
        throw toMcpError(err);
      }
    },
  );

  server.resource(
    "project-presence",
    "tila://project/presence",
    {
      description:
        "Machines known to the project, each tagged `active` (seen recently) or not. The list includes inactive machines; filter on `active` for currently-online agents.",
      mimeType: "application/json",
    },
    async (uri) => {
      try {
        const result = await client.get(`${projectBase}/presence/all`);
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "application/json",
              text: JSON.stringify(result),
            },
          ],
        };
      } catch (err) {
        throw toMcpError(err);
      }
    },
  );

  server.resource(
    "project-schema",
    "tila://project/schema",
    {
      description: "Current tila schema version and definition",
      mimeType: "application/json",
    },
    async (uri) => {
      try {
        const result = await client.get(`${projectBase}/schema`);
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "application/json",
              text: JSON.stringify(result),
            },
          ],
        };
      } catch (err) {
        throw toMcpError(err);
      }
    },
  );

  // Register opt-in record resources (async -- fetches schema at startup)
  await registerRecordResources(server, client, projectId);
}
