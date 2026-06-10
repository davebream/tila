import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TilaFacade } from "tila-sdk";
import { z } from "zod";
import { toMcpError } from "../errors";

type TaskMethods = TilaFacade["tasks"];

function registerCrudTools(
  server: McpServer,
  tasks: TaskMethods,
  namePrefix: string,
  labelSingular: string,
  labelPlural: string,
): void {
  server.tool(
    `${namePrefix}_create`,
    `Create a new ${labelSingular} (task, epic, etc.) in the tila project. Returns the created ${labelSingular} object.`,
    {
      id: z.string().describe(`Unique ${labelSingular} ID`),
      type: z
        .string()
        .describe(
          `${labelSingular[0].toUpperCase()}${labelSingular.slice(1)} type (e.g. 'task', 'epic')`,
        ),
      data: z
        .record(z.unknown())
        .default({})
        .describe(`Key-value data fields for the ${labelSingular}`),
      tags: z
        .array(z.string())
        .optional()
        .describe(
          `Optional tags for the ${labelSingular} (e.g. ['team:eng', 'env:prod'])`,
        ),
    },
    async ({ id, type, data, tags }) => {
      try {
        const result = await tasks.create(id, type, data, tags);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        throw toMcpError(err);
      }
    },
  );

  server.tool(
    `${namePrefix}_list`,
    `List all ${labelPlural} in the project. Returns compact format (id, type, title, status, claimed_by, blockers, artifacts) to minimize token usage.`,
    {
      type: z.string().optional().describe(`Filter by ${labelSingular} type`),
      status: z.string().optional().describe("Filter by status field value"),
      tag_filter: z
        .array(z.string())
        .optional()
        .describe(
          'Filter by tags using AND semantics — only items carrying ALL listed tags are returned. Tags are facet-namespaced (e.g. ["repo:tila", "team:platform"]).',
        ),
    },
    async ({ type, status, tag_filter }) => {
      try {
        const result = await tasks.list({
          type,
          status,
          compact: true,
          ...(tag_filter?.length ? { tagFilter: tag_filter } : {}),
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
    `${namePrefix}_show`,
    `Get detailed information about a single ${labelSingular}, including its relationships. Returns the full ${labelSingular} object and relationship list.`,
    {
      id: z
        .string()
        .describe(
          `${labelSingular[0].toUpperCase()}${labelSingular.slice(1)} ID to retrieve`,
        ),
    },
    async ({ id }) => {
      try {
        const result = await tasks.get(id);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        throw toMcpError(err);
      }
    },
  );

  server.tool(
    `${namePrefix}_update`,
    `Update a ${labelSingular}'s data fields. Requires a valid fencing token from tila_claim_acquire. A stale fence (from an expired or superseded claim) will be rejected with a 409 error.`,
    {
      id: z
        .string()
        .describe(
          `${labelSingular[0].toUpperCase()}${labelSingular.slice(1)} ID to update`,
        ),
      data: z
        .record(z.unknown())
        .describe(`Key-value data fields to merge into the ${labelSingular}`),
      fence: z
        .number()
        .int()
        .describe(
          "Fencing token from tila_claim_acquire -- required for write authorization",
        ),
    },
    async ({ id, data, fence }) => {
      try {
        const result = await tasks.update(id, data, fence);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        throw toMcpError(err);
      }
    },
  );

  server.tool(
    `${namePrefix}_ready`,
    `List ${labelPlural} that are ready for work -- no open blockers, no pending gates, not claimed by another agent. Returns up to limit ${labelSingular} objects (default 50); add {truncated:true,total:n} when capped.`,
    {
      type: z.string().optional().describe(`Filter by ${labelSingular} type`),
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .default(50)
        .describe("Maximum number of results to return (default 50)"),
    },
    async ({ type, limit = 50 }) => {
      try {
        const result = await tasks.ready({ type });
        // Defensive: if entities array is missing, return result unchanged
        const arr = (result as Record<string, unknown>).entities;
        if (!Array.isArray(arr) || arr.length <= limit) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result) }],
          };
        }
        const capped = {
          ...(result as Record<string, unknown>),
          entities: arr.slice(0, limit),
          truncated: true,
          total: arr.length,
        };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(capped) }],
        };
      } catch (err) {
        throw toMcpError(err);
      }
    },
  );

  server.tool(
    `${namePrefix}_archive`,
    `Archive a ${labelSingular}. Requires a valid fencing token from tila_claim_acquire. The ${labelSingular} is soft-deleted and removed from the ready set.`,
    {
      id: z
        .string()
        .describe(
          `${labelSingular[0].toUpperCase()}${labelSingular.slice(1)} ID to archive`,
        ),
      fence: z
        .number()
        .int()
        .describe(
          "Fencing token from tila_claim_acquire -- required for archive",
        ),
    },
    async ({ id, fence }) => {
      try {
        const result = await tasks.archive(id, fence);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        throw toMcpError(err);
      }
    },
  );

  server.tool(
    `${namePrefix}_relationships_add`,
    `Add a relationship between two ${labelPlural}. Creates a directed edge from one ${labelSingular} to another with a named type.`,
    {
      from_id: z.string().describe(`Source ${labelSingular} ID`),
      to_id: z.string().describe(`Target ${labelSingular} ID`),
      type: z
        .string()
        .describe("Relationship type (e.g. 'blocks', 'parent-of')"),
    },
    async ({ from_id, to_id, type }) => {
      try {
        const result = await tasks.addRelationship(from_id, to_id, type);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        throw toMcpError(err);
      }
    },
  );

  server.tool(
    `${namePrefix}_relationships_list`,
    `List all relationships for a ${labelSingular}. Returns both incoming and outgoing relationships. Up to limit results (default 50); adds {truncated:true,total:n} when capped.`,
    {
      id: z
        .string()
        .describe(
          `${labelSingular[0].toUpperCase()}${labelSingular.slice(1)} ID to list relationships for`,
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .default(50)
        .describe("Maximum number of relationships to return (default 50)"),
    },
    async ({ id, limit = 50 }) => {
      try {
        const result = await tasks.listRelationships({ fromId: id });
        // Defensive: if relationships array is missing, return result unchanged
        const arr = (result as Record<string, unknown>).relationships;
        if (!Array.isArray(arr) || arr.length <= limit) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result) }],
          };
        }
        const capped = {
          ...(result as Record<string, unknown>),
          relationships: arr.slice(0, limit),
          truncated: true,
          total: arr.length,
        };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(capped) }],
        };
      } catch (err) {
        throw toMcpError(err);
      }
    },
  );
}

export function registerEntityTools(
  server: McpServer,
  facade: TilaFacade,
  _projectId: string,
): void {
  registerCrudTools(server, facade.tasks, "tila_task", "task", "tasks");
}
