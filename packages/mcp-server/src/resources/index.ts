import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TilaSchemaTomlSchema } from "@tila/schemas";
import { parse } from "smol-toml";
import type { TilaFacade } from "tila-sdk";
import { toMcpError } from "../errors";

/** Resolve schema inside the authenticated request, never during registration. */
async function registerRecordResources(
  server: McpServer,
  facade: TilaFacade,
): Promise<void> {
  server.resource(
    "project-record",
    new ResourceTemplate("tila://records/{type}/{key}", { list: undefined }),
    {
      description: "Read a record type explicitly enabled as an MCP resource",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const type = String(variables.type);
      const key = String(variables.key);
      const result = (await facade.schema.get()) as {
        schema: { definition?: string } | null;
      };
      const schema = TilaSchemaTomlSchema.parse(
        parse(result.schema?.definition ?? ""),
      );
      if (!schema.records?.[type]?.mcp_resource)
        throw new Error("Record type is not exposed as a resource");
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(await facade.records.get(type, key)),
          },
        ],
      };
    },
  );
}

export async function registerAllResources(
  server: McpServer,
  facade: TilaFacade,
  _projectId: string,
): Promise<void> {
  server.resource(
    "project-summary",
    "tila://project/summary",
    {
      description:
        "Project summary: entity counts, status breakdown, active claims, ready count, online participants",
      mimeType: "application/json",
    },
    async (uri) => {
      try {
        const result = await facade.summary.get();
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
        const result = await facade.tasks.ready();
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
        "Participants known to the project, each tagged `active` (seen recently) or not. The list includes inactive participants; filter on `active` for currently-online clients.",
      mimeType: "application/json",
    },
    async (uri) => {
      try {
        const result = await facade.presence.listAll();
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
        const result = await facade.schema.get();
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

  // Register a generic template; schema authorization happens on each read.
  await registerRecordResources(server, facade);
}
