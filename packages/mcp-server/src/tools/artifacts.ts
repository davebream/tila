import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { TilaFacade } from "tila-sdk";
import { z } from "zod";
import { toMcpError } from "../errors";

export function registerArtifactTools(
  server: McpServer,
  facade: TilaFacade,
  _projectId: string,
): void {
  const artifacts = facade.artifacts;
  const search = facade.search;

  server.tool(
    "tila_artifact_put",
    "Upload an artifact (file content) to the project. Content must be base64-encoded. Returns the artifact key, byte count, and deduplication status.",
    {
      content: z.string().describe("Base64-encoded file content"),
      kind: z.string().describe("Artifact kind (e.g. 'log', 'report', 'plan')"),
      mime_type: z
        .string()
        .default("application/octet-stream")
        .describe("MIME type of the content"),
      resource: z
        .string()
        .optional()
        .describe("Entity ID to associate this artifact with"),
      fence: z
        .number()
        .int()
        .optional()
        .describe("Fencing token if uploading against a claimed entity"),
      tags: z
        .array(z.string())
        .optional()
        .describe(
          "Optional tags for the artifact (e.g. ['team:eng', 'env:prod'])",
        ),
    },
    async ({ content, kind, mime_type, resource, fence, tags }) => {
      try {
        const bytes = Buffer.from(content, "base64");
        const blob = new Blob([bytes], { type: mime_type });
        // Remote-only: `artifacts.upload` posts a multipart form to the Worker's
        // R2 store. In local mode the REMOTE_ONLY_TOOLS guard short-circuits
        // this tool before the handler runs (see remote-only.ts); the facade
        // would otherwise throw LocalUnsupportedError here.
        const result = await artifacts.upload(blob, {
          kind,
          mimeType: mime_type,
          resource,
          fence,
          tags,
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
    "tila_artifact_search",
    "Full-text search restricted to artifacts, with optional `kind` and associated-task (`resource`) filters. Prefer `tila_search` for general discovery; use this only when you know the target is an artifact and need an artifact-specific filter.",
    {
      q: z.string().min(1).describe("Search query string"),
      kind: z.string().optional().describe("Filter by artifact kind"),
      resource: z
        .string()
        .optional()
        .describe("Filter by associated entity ID"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(20)
        .describe("Maximum results to return"),
      tag_filter: z
        .array(z.string())
        .optional()
        .describe(
          'Filter by tags using AND semantics — only artifacts carrying ALL listed tags are returned. Tags are facet-namespaced (e.g. ["repo:tila", "team:platform"]).',
        ),
    },
    async ({ q, kind, resource, limit, tag_filter }) => {
      try {
        const result = await artifacts.search(q, {
          kind,
          resource,
          limit: String(limit),
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
    "tila_artifact_write_text",
    "Write text content directly as an artifact. Use for markdown, plain text, JSON, YAML, or any text content. No file or base64 encoding required. Returns the artifact key, byte count, and deduplication status.",
    {
      content: z.string().min(1).describe("Text content to store"),
      kind: z
        .string()
        .describe("Artifact kind (e.g. 'plan', 'report', 'lesson', 'log')"),
      mime_type: z
        .string()
        .default("text/markdown")
        .describe("MIME type — defaults to text/markdown"),
      resource: z
        .string()
        .optional()
        .describe("Entity ID to associate this artifact with"),
      fence: z
        .number()
        .int()
        .optional()
        .describe("Fencing token if uploading against a claimed entity"),
      tags: z
        .array(z.string())
        .optional()
        .describe(
          "Optional tags for the artifact (e.g. ['team:eng', 'env:prod'])",
        ),
    },
    async ({ content, kind, mime_type, resource, fence, tags }) => {
      try {
        const result = await artifacts.writeText(content, {
          kind,
          mimeType: mime_type,
          resource,
          fence,
          ...(tags !== undefined ? { tags } : {}),
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
    "tila_artifact_read_text",
    "Read the text content of an artifact by key. Only works for text/* MIME types (markdown, plain text, JSON, YAML). Returns up to max_chars characters (default 10000); larger artifacts are truncated with a marker. Pass a higher max_chars to read more.",
    {
      key: z
        .string()
        .describe(
          "Artifact key (e.g. 'sources/abc123.md', 'produced/T-142/def456.md')",
        ),
      max_chars: z
        .number()
        .int()
        .min(1)
        .default(10000)
        .describe(
          "Maximum characters to return (default 10000). Truncated artifacts include a marker with char/byte counts.",
        ),
    },
    async ({ key, max_chars = 10000 }) => {
      try {
        const { content: text, mimeType } = await artifacts.readText(key);
        // Cross-backend text guard owned by THIS layer: the HTTP readText throws
        // a TypeError for non-text MIME, but the LOCAL adapter's readText returns
        // whatever is stored without a content-type check. This check makes the
        // tool reject non-text uniformly (as a clean McpError) across both
        // backends — it is NOT redundant for local mode.
        if (!mimeType.startsWith("text/")) {
          throw new McpError(
            ErrorCode.InvalidRequest,
            `Artifact ${key} has MIME type ${mimeType} — tila_artifact_read_text only supports text/* artifacts`,
          );
        }
        if (text.length > max_chars) {
          const byteLength = Buffer.byteLength(text, "utf8");
          const truncated = `${text.slice(0, max_chars)}\n\n...[truncated: returned ${max_chars} chars of ${byteLength} bytes total]`;
          return {
            content: [{ type: "text" as const, text: truncated }],
          };
        }
        return {
          content: [{ type: "text" as const, text }],
        };
      } catch (err) {
        if (err instanceof McpError) throw err;
        throw toMcpError(err);
      }
    },
  );

  // Unified search across tasks and artifacts
  server.tool(
    "tila_search",
    "Unified full-text search across tasks and artifacts. Use this for general discovery when you don't know whether the match is a task or an artifact. Each result is tagged by type — `entity` (a task) or `artifact`.",
    {
      q: z.string().min(1).describe("Search query string"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(20)
        .describe("Maximum results to return"),
      tag_filter: z
        .array(z.string())
        .optional()
        .describe(
          'Filter by tags using AND semantics — only results carrying ALL listed tags are returned. Tags are facet-namespaced (e.g. ["repo:tila", "team:platform"]).',
        ),
    },
    async ({ q, limit, tag_filter }) => {
      try {
        const result = await search.search(q, {
          limit,
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
    "tila_artifact_get_latest",
    "Get the latest (most recent) artifact of a given kind for a resource. Follows supersedes chains when available, falls back to produced_at ordering. Returns null if no artifact exists.",
    {
      kind: z.string().describe("Artifact kind (e.g. 'plan', 'design')"),
      resource: z.string().describe("Resource/entity ID"),
    },
    async ({ kind, resource }) => {
      try {
        const pointer = await artifacts.getLatest(kind, resource);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ ok: true, pointer }),
            },
          ],
        };
      } catch (err) {
        throw toMcpError(err);
      }
    },
  );

  // Artifact relationship tools
  server.tool(
    "tila_artifact_relationships_add",
    "Add a relationship between artifacts. Requires at least one of to_key or to_uri.",
    {
      from_key: z.string().describe("Source artifact key"),
      to_key: z
        .string()
        .optional()
        .describe("Target artifact key (within this project)"),
      to_uri: z
        .string()
        .optional()
        .describe("Target artifact URI (external reference)"),
      type: z
        .string()
        .describe("Relationship type (e.g. 'entry-of', 'derived-from')"),
    },
    async ({ from_key, to_key, to_uri, type }) => {
      if (!to_key && !to_uri) {
        throw new McpError(
          ErrorCode.InvalidRequest,
          "Either to_key or to_uri must be provided",
        );
      }
      try {
        // The facade takes a single target and disambiguates to_key vs to_uri by
        // the `://` heuristic. Prefer the explicit key; fall back to the URI.
        const target = to_key ?? (to_uri as string);
        const result = await artifacts.addRelationship(from_key, target, type);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        throw toMcpError(err);
      }
    },
  );

  server.tool(
    "tila_artifact_relationships_list",
    "List all relationships for an artifact.",
    {
      key: z.string().describe("Artifact key to list relationships for"),
    },
    async ({ key }) => {
      try {
        const result = await artifacts.listRelationships(key);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        throw toMcpError(err);
      }
    },
  );

  // Content grep tool
  server.tool(
    "tila_artifact_grep",
    "Exact substring / bounded-regex line-level matching over raw artifact bytes, returning {line,text,col} per match (col is a character offset, ASCII-accurate). Use this for precise content checks (does an artifact contain X? does a patch contain a forbidden token?). For ranked discovery use tila_search / tila_artifact_search.",
    {
      pattern: z
        .string()
        .min(1)
        .max(200)
        .describe(
          "Search pattern (literal substring by default, or bounded regex when regex=true)",
        ),
      kind: z.string().optional().describe("Filter by artifact kind"),
      resource: z
        .string()
        .optional()
        .describe("Filter by associated entity ID"),
      regex: z
        .boolean()
        .default(false)
        .describe(
          "When true, interpret pattern as a bounded regex (no backreferences, no lookaround, no nested unbounded quantifiers). Default false (literal substring).",
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(50)
        .describe(
          "Maximum number of candidate artifacts to scan (default 50, max 100)",
        ),
    },
    async ({ pattern, kind, resource, regex, limit }) => {
      try {
        const result = await artifacts.grep(pattern, {
          kind,
          resource,
          regex,
          limit,
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
