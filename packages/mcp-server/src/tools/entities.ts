import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  LifecycleOutcomeSchema,
  ListCursorSchema,
  TASK_LIST_SORTS,
  TaskStateSchema,
} from "@tila/schemas";
import type { TilaFacade } from "tila-sdk";
import { z } from "zod";
import { toMcpError } from "../errors";
import { registerPrimitiveTool } from "../tool-registration";

type TaskMethods = TilaFacade["tasks"];

function registerCrudTools(
  server: McpServer,
  tasks: TaskMethods,
  namePrefix: string,
  labelSingular: string,
  labelPlural: string,
): void {
  registerPrimitiveTool(
    server,
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
        .record(z.string(), z.unknown())
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

  registerPrimitiveTool(
    server,
    `${namePrefix}_list`,
    `List ${labelPlural} with exact total, scope, has_more and next_cursor. Pass the cursor with the same filters to continue. HTTP returns compact entities; local mode returns full entities.`,
    {
      type: z.string().optional().describe(`Filter by ${labelSingular} type`),
      status: z.string().optional().describe("Filter by status field value"),
      blocked: z
        .boolean()
        .optional()
        .describe(
          "Only open tasks waiting on unresolved, missing or cyclic prerequisites; false does not filter",
        ),
      outcome: z
        .array(LifecycleOutcomeSchema)
        .min(1)
        .optional()
        .describe("Match states declared for these lifecycle outcomes"),
      state: z
        .array(TaskStateSchema)
        .min(1)
        .optional()
        .describe(
          "Only tasks in one of these states: the value of each type's lifecycle field, or status for a type with no lifecycle. Exact match across every type.",
        ),
      sort: z
        .enum(TASK_LIST_SORTS)
        .optional()
        .describe(
          "Sort key; state orders by the same state the state filter matches. Ties break by id.",
        ),
      order: z.enum(["asc", "desc"]).optional().describe("Sort direction"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .describe("Maximum results in this page"),
      cursor: ListCursorSchema.optional().describe(
        "next_cursor from the preceding page with the same filters and sort",
      ),
      tag_filter: z
        .array(z.string())
        .optional()
        .describe(
          'AND filter: return only tasks with ALL listed facet-namespaced tags (e.g. ["repo:tila","team:platform"]).',
        ),
    },
    async ({
      type,
      status,
      tag_filter,
      blocked,
      outcome,
      state,
      sort,
      order,
      limit,
      cursor,
    }) => {
      try {
        const result = await tasks.list({
          type,
          status,
          compact: true,
          ...(blocked !== undefined ? { blocked } : {}),
          ...(outcome !== undefined ? { outcome } : {}),
          ...(state !== undefined ? { state } : {}),
          ...(sort !== undefined ? { sort } : {}),
          ...(order !== undefined ? { order } : {}),
          ...(limit !== undefined ? { limit: String(limit) } : {}),
          ...(cursor !== undefined ? { cursor } : {}),
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

  registerPrimitiveTool(
    server,
    `${namePrefix}_show`,
    `Get detailed information about a single ${labelSingular}, including its relationships. Returns the full ${labelSingular} object and up to limit relationships (default 50); adds {truncated:true,total:n} when capped.`,
    {
      id: z
        .string()
        .describe(
          `${labelSingular[0].toUpperCase()}${labelSingular.slice(1)} ID to retrieve`,
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
        const result = await tasks.get(id);
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

  registerPrimitiveTool(
    server,
    `${namePrefix}_update`,
    `Update a ${labelSingular}'s data fields. Requires a valid fencing token from tila_claim_acquire. A stale fence (from an expired or superseded claim) will be rejected with a 409 error.`,
    {
      id: z
        .string()
        .describe(
          `${labelSingular[0].toUpperCase()}${labelSingular.slice(1)} ID to update`,
        ),
      data: z
        .record(z.string(), z.unknown())
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

  registerPrimitiveTool(
    server,
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

  registerPrimitiveTool(
    server,
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

  registerPrimitiveTool(
    server,
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

  registerPrimitiveTool(
    server,
    `${namePrefix}_relationships_list`,
    `List OUTBOUND relationships for a ${labelSingular} (edges where this ${labelSingular} is the source/from). Up to limit results (default 50); adds {truncated:true,total:n} when capped.`,
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
