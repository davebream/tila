import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TilaClient } from "tila-sdk";
import { createRecordMethods } from "tila-sdk";
import { z } from "zod";
import { toMcpError } from "../errors";

export function registerRecordTools(
  server: McpServer,
  client: TilaClient,
  projectId: string,
): void {
  const records = createRecordMethods(client, projectId);

  server.tool(
    "tila_record_get",
    "Get a record by type and key. Returns the full record value, metadata, tags, and fencing token needed for subsequent mutations.",
    {
      type: z.string().describe("Record type (e.g. 'pipeline_config')"),
      key: z.string().describe("Record key (e.g. 'prod' or 'env/staging')"),
    },
    async ({ type, key }) => {
      try {
        const result = await records.get(type, key);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        throw toMcpError(err);
      }
    },
  );

  server.tool(
    "tila_record_set",
    "Set (full replace) a record's value. Requires a fencing token from tila_record_get. Returns the new fencing token.",
    {
      type: z.string().describe("Record type"),
      key: z.string().describe("Record key"),
      value: z.record(z.unknown()).describe("Complete JSON value to set"),
      fence: z
        .number()
        .int()
        .describe(
          "Fencing token from tila_record_get -- required for write authorization",
        ),
    },
    async ({ type, key, value, fence }) => {
      try {
        const result = await records.set(type, key, { value, fence });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        throw toMcpError(err);
      }
    },
  );

  server.tool(
    "tila_record_patch",
    "Apply a JSON Merge Patch (RFC 7396) to a record's value. Requires a fencing token from tila_record_get. Returns the new fencing token.",
    {
      type: z.string().describe("Record type"),
      key: z.string().describe("Record key"),
      patch: z
        .record(z.unknown())
        .describe("JSON Merge Patch object -- null values delete keys"),
      fence: z
        .number()
        .int()
        .describe(
          "Fencing token from tila_record_get -- required for write authorization",
        ),
    },
    async ({ type, key, patch, fence }) => {
      try {
        const result = await records.patch(type, key, { patch, fence });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        throw toMcpError(err);
      }
    },
  );

  server.tool(
    "tila_record_list",
    "List records of a given type. Returns metadata only (type, key, revision, updated_at, updated_by, archived, tags) -- no value field. Use tila_record_get to read individual record values.",
    {
      type: z.string().describe("Record type to list"),
      tag: z.string().optional().describe("Filter by tag"),
      filter: z
        .string()
        .optional()
        .describe("JSON data filter expression (stringified JSON object)"),
      include_archived: z
        .boolean()
        .optional()
        .describe("Include archived records (default: false)"),
      tag_filter: z
        .array(z.string())
        .optional()
        .describe(
          'Filter by tags using AND semantics — only records carrying ALL listed tags are returned. Tags are facet-namespaced (e.g. ["repo:tila", "team:platform"]).',
        ),
    },
    async ({ type, tag, filter, include_archived, tag_filter }) => {
      try {
        const query: Record<string, string | undefined> = { tag, filter };
        if (include_archived !== undefined) {
          query["include-archived"] = String(include_archived);
        }
        const result = await records.list(type, {
          ...query,
          ...(tag_filter !== undefined ? { tagFilter: tag_filter } : {}),
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
    "tila_record_archive",
    "Archive a record. Requires a fencing token from tila_record_get. Returns the new fencing token.",
    {
      type: z.string().describe("Record type"),
      key: z.string().describe("Record key"),
      fence: z
        .number()
        .int()
        .describe(
          "Fencing token from tila_record_get -- required for write authorization",
        ),
    },
    async ({ type, key, fence }) => {
      try {
        const result = await records.archive(type, key, { fence });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        throw toMcpError(err);
      }
    },
  );

  server.tool(
    "tila_record_unarchive",
    "Unarchive a previously archived record. Requires a fencing token from tila_record_get. Returns the new fencing token.",
    {
      type: z.string().describe("Record type"),
      key: z.string().describe("Record key"),
      fence: z
        .number()
        .int()
        .describe(
          "Fencing token from tila_record_get -- required for write authorization",
        ),
    },
    async ({ type, key, fence }) => {
      try {
        const result = await records.unarchive(type, key, { fence });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        throw toMcpError(err);
      }
    },
  );

  server.tool(
    "tila_record_history",
    "Get revision history for a record. Returns newest-first list of revisions with operation, timestamp, and actor.",
    {
      type: z.string().describe("Record type"),
      key: z.string().describe("Record key"),
      limit: z
        .number()
        .int()
        .optional()
        .describe("Maximum number of history entries to return"),
      values: z
        .boolean()
        .optional()
        .describe(
          "Include value snapshots in history entries (default: false)",
        ),
    },
    async ({ type, key, limit, values }) => {
      try {
        const result = await records.history(type, key, { limit, values });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        throw toMcpError(err);
      }
    },
  );
}
