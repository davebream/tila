import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import type { SchemaBackend } from "@tila/core";
import {
  RecordDefinitionSchema,
  type TilaSchemaToml,
  TilaSchemaTomlSchema,
} from "@tila/schemas";
import { defineCommand } from "citty";
import { parse as parseTOML } from "smol-toml";
import yaml, { type YAMLWarning } from "yaml";
import type { z } from "zod";
import { resolveContext } from "../context";
import {
  formatTimestamp,
  printJson,
  renderTable,
  withSpinner,
} from "../lib/output";

/** Parse a file as JSON or YAML based on extension. */
function parseInputFile(filePath: string): Record<string, unknown> {
  const content = readFileSync(filePath, "utf-8");
  const ext = extname(filePath).toLowerCase();
  if (ext === ".yaml" || ext === ".yml") {
    try {
      // Use parseDocument to detect and reject custom YAML tags (e.g. !!python/object)
      // which are a security concern. TAG_RESOLVE_FAILED warnings indicate custom tags.
      const doc = yaml.parseDocument(content, { schema: "core" });
      const tagErrors = doc.warnings.filter(
        (w: YAMLWarning) => w.code === "TAG_RESOLVE_FAILED",
      );
      if (tagErrors.length > 0) {
        throw new Error(
          `Unsupported YAML tag: ${tagErrors[0].message.split("\n")[0]}`,
        );
      }
      if (doc.errors.length > 0) {
        throw doc.errors[0];
      }
      return doc.toJS() as Record<string, unknown>;
    } catch (err) {
      throw new Error(
        `Failed to parse YAML file: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  try {
    return JSON.parse(content) as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `Failed to parse JSON file: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Fetch the schema definition to read a record type's `format`/`history`
 * metadata. Backend-agnostic: reads through the `SchemaBackend` so it works in
 * both local and remote mode.
 */
async function fetchRecordTypeDef(
  schemaBackend: SchemaBackend,
  type: string,
): Promise<z.infer<typeof RecordDefinitionSchema> | null> {
  try {
    const res = await schemaBackend.getCurrentSchema();
    if (!res.definition) return null;
    const schema = TilaSchemaTomlSchema.parse(parseTOML(res.definition));
    const records = schema.records;
    if (!records?.[type]) return null;
    return RecordDefinitionSchema.parse(records[type]);
  } catch {
    return null;
  }
}

export default defineCommand({
  meta: { name: "record", description: "Manage typed records" },
  subCommands: {
    set: defineCommand({
      meta: { name: "set", description: "Create or update a record" },
      args: {
        type: {
          type: "positional",
          description: "Record type (e.g. pipeline_config)",
          required: true,
        },
        key: {
          type: "positional",
          description: "Record key (e.g. main, api/staging)",
          required: true,
        },
        file: {
          type: "positional",
          description: "Path to JSON or YAML file with record value",
          required: true,
        },
        fence: {
          type: "string",
          description: "Fencing token (required for updates)",
        },
        json: {
          type: "boolean",
          description: "Output as JSON",
          default: false,
        },
      },
      async run({ args }) {
        const ctx = await resolveContext();
        const { config } = ctx;
        const recordType = args.type as string;
        const key = args.key as string;
        const filePath = args.file as string;

        let value: Record<string, unknown>;
        try {
          value = parseInputFile(filePath);
        } catch (err) {
          console.error(`Error: ${(err as Error).message}`);
          process.exit(1);
        }

        // Check if snapshot preupload is needed
        let sourceArtifactKey: string | null = null;
        const typeDef = await fetchRecordTypeDef(ctx.schema, recordType);
        if (typeDef?.history === "snapshot") {
          // Snapshot source preupload writes to R2 via the Worker — remote-only.
          // Local mode has no R2; surface a clear error rather than silently
          // dropping the source artifact (the local backend would still write
          // the record, but without the snapshot provenance the type promises).
          if (!ctx.client) {
            console.error(
              `Error: record type "${recordType}" uses history = "snapshot", which requires a remote backend (snapshot source artifacts are uploaded to R2 via the Worker). It is not supported in local mode.`,
            );
            process.exit(1);
            return;
          }
          try {
            const content = readFileSync(filePath);
            const fileName = filePath.split("/").pop() ?? "file";
            const formData = new FormData();
            formData.append("file", new Blob([content]), fileName);
            formData.append("kind", "record-snapshot-source");
            formData.append("resource", `record:${recordType}/${key}`);
            const uploadResult = await ctx.client.postFormData(
              `/projects/${config.project_id}/artifacts`,
              formData,
            );
            sourceArtifactKey = (uploadResult as Record<string, unknown>)
              .key as string;
          } catch (err) {
            console.error(
              `Warning: snapshot preupload failed: ${(err as Error).message}. Continuing without source artifact.`,
            );
          }
        }

        const fence = args.fence ? Number(args.fence) : undefined;

        if (fence !== undefined) {
          // Update existing record (set with fence)
          const result = await withSpinner("Setting record...", () =>
            ctx.record.setRecord({
              type: recordType,
              key,
              value,
              fence,
              sourceArtifactKey,
            }),
          );
          if (args.json) {
            printJson(result);
            return;
          }
          console.log(
            `Set record ${recordType}/${key} (rev ${result.revision}, fence ${result.fence})`,
          );
        } else {
          // Create new record (no fence)
          const result = await withSpinner("Creating record...", () =>
            ctx.record.createRecord({
              type: recordType,
              key,
              value,
              sourceArtifactKey,
            }),
          );
          if (args.json) {
            printJson(result);
            return;
          }
          console.log(
            `Set record ${recordType}/${key} (rev ${result.revision}, fence ${result.fence})`,
          );
        }
      },
    }),

    get: defineCommand({
      meta: { name: "get", description: "Get a record value" },
      args: {
        type: {
          type: "positional",
          description: "Record type",
          required: true,
        },
        key: {
          type: "positional",
          description: "Record key",
          required: true,
        },
        format: {
          type: "string",
          description: "Output format: json or yaml",
        },
        json: {
          type: "boolean",
          description: "Output full API envelope as JSON",
          default: false,
        },
      },
      async run({ args }) {
        const ctx = await resolveContext();
        const recordType = args.type as string;
        const key = args.key as string;

        const record = await withSpinner("Fetching record...", () =>
          ctx.record.getRecord(recordType, key),
        );

        if (!record) {
          console.error(`Error: record ${recordType}/${key} not found`);
          process.exit(1);
          return;
        }

        if (args.json) {
          printJson({ ok: true, record, fence: record.fence });
          return;
        }

        // Determine output format: --format flag wins; else fetch schema type def; else default "json"
        let outputFormat = args.format as string | undefined;
        if (!outputFormat) {
          const typeDef = await fetchRecordTypeDef(ctx.schema, recordType);
          outputFormat = typeDef?.format ?? "json";
        }

        if (outputFormat === "yaml") {
          console.log(yaml.stringify(record.value).trimEnd());
        } else {
          console.log(JSON.stringify(record.value, null, 2));
        }
      },
    }),

    list: defineCommand({
      meta: { name: "list", description: "List records of a type" },
      args: {
        type: {
          type: "positional",
          description: "Record type",
          required: true,
        },
        tag: { type: "string", description: "Filter by tag" },
        "include-archived": {
          type: "boolean",
          description: "Include archived records",
          default: false,
        },
        filter: { type: "string", description: "JSON data filter" },
        limit: { type: "string", description: "Maximum results" },
        json: {
          type: "boolean",
          description: "Output as JSON",
          default: false,
        },
      },
      async run({ args }) {
        const ctx = await resolveContext();
        const recordType = args.type as string;

        let dataFilter: Record<string, unknown> | undefined;
        if (args.filter) {
          try {
            dataFilter = JSON.parse(args.filter as string) as Record<
              string,
              unknown
            >;
          } catch {
            console.error("Error: --filter must be valid JSON");
            process.exit(1);
            return;
          }
        }

        const page = await withSpinner("Fetching records...", () =>
          ctx.record.listRecords({
            type: recordType,
            tag: args.tag ? (args.tag as string) : undefined,
            includeArchived: Boolean(args["include-archived"]),
            dataFilter,
            limit: args.limit ? Number(args.limit) : undefined,
          }),
        );

        if (args.json) {
          printJson({
            ok: true,
            items: page.items,
            meta: {
              total: page.total,
              limit: args.limit ? Number(args.limit) : page.total,
              next_cursor: page.next_cursor,
            },
          });
          return;
        }

        if (page.items.length === 0) {
          console.log("No records found.");
          return;
        }

        renderTable(
          page.items.map((item) => ({
            key: item.key,
            revision: item.revision,
            updated: formatTimestamp(item.updated_at),
            updated_by: item.updated_by,
            archived: item.archived ? "yes" : "",
          })),
          [
            { key: "key", label: "Key" },
            { key: "revision", label: "Rev" },
            { key: "updated", label: "Updated" },
            { key: "updated_by", label: "Updated By" },
            { key: "archived", label: "Archived" },
          ],
        );

        if (page.next_cursor === "truncated") {
          console.log(`(results truncated at ${args.limit ?? page.total})`);
        }
      },
    }),

    patch: defineCommand({
      meta: { name: "patch", description: "Patch a record (JSON Merge Patch)" },
      args: {
        type: {
          type: "positional",
          description: "Record type",
          required: true,
        },
        key: {
          type: "positional",
          description: "Record key",
          required: true,
        },
        json: {
          type: "string",
          description: "Inline JSON patch payload",
          required: true,
        },
        fence: {
          type: "string",
          description: "Fencing token (required)",
          required: true,
        },
      },
      async run({ args }) {
        const recordType = args.type as string;
        const key = args.key as string;
        const fenceStr = args.fence as string | undefined;

        if (!fenceStr) {
          console.error("Error: --fence is required for patch");
          process.exit(1);
        }

        let patch: Record<string, unknown>;
        try {
          patch = JSON.parse(args.json as string) as Record<string, unknown>;
        } catch {
          console.error("Error: --json must be valid JSON");
          process.exit(1);
        }

        const ctx = await resolveContext();
        const result = await withSpinner("Patching record...", () =>
          ctx.record.patchRecord({
            type: recordType,
            key,
            patch,
            fence: Number(fenceStr),
          }),
        );

        console.log(
          `Patched record ${recordType}/${key} (rev ${result.revision}, fence ${result.fence})`,
        );
      },
    }),

    archive: defineCommand({
      meta: { name: "archive", description: "Archive a record" },
      args: {
        type: {
          type: "positional",
          description: "Record type",
          required: true,
        },
        key: { type: "positional", description: "Record key", required: true },
        fence: {
          type: "string",
          description: "Fencing token (required)",
          required: true,
        },
        json: {
          type: "boolean",
          description: "Output as JSON",
          default: false,
        },
      },
      async run({ args }) {
        const recordType = args.type as string;
        const key = args.key as string;
        const fenceStr = args.fence as string | undefined;

        if (!fenceStr) {
          console.error("Error: --fence is required for archive");
          process.exit(1);
        }

        const ctx = await resolveContext();
        const result = await withSpinner("Archiving record...", () =>
          ctx.record.archiveRecord({
            type: recordType,
            key,
            fence: Number(fenceStr),
          }),
        );

        if (args.json) {
          printJson(result);
          return;
        }
        console.log(
          `Archived record ${recordType}/${key} (rev ${result.revision}, fence ${result.fence})`,
        );
      },
    }),

    unarchive: defineCommand({
      meta: { name: "unarchive", description: "Unarchive a record" },
      args: {
        type: {
          type: "positional",
          description: "Record type",
          required: true,
        },
        key: { type: "positional", description: "Record key", required: true },
        fence: {
          type: "string",
          description: "Fencing token (required)",
          required: true,
        },
        json: {
          type: "boolean",
          description: "Output as JSON",
          default: false,
        },
      },
      async run({ args }) {
        const recordType = args.type as string;
        const key = args.key as string;
        const fenceStr = args.fence as string | undefined;

        if (!fenceStr) {
          console.error("Error: --fence is required for unarchive");
          process.exit(1);
        }

        const ctx = await resolveContext();
        const result = await withSpinner("Unarchiving record...", () =>
          ctx.record.unarchiveRecord({
            type: recordType,
            key,
            fence: Number(fenceStr),
          }),
        );

        if (args.json) {
          printJson(result);
          return;
        }
        console.log(
          `Unarchived record ${recordType}/${key} (rev ${result.revision}, fence ${result.fence})`,
        );
      },
    }),

    history: defineCommand({
      meta: { name: "history", description: "Show record revision history" },
      args: {
        type: {
          type: "positional",
          description: "Record type",
          required: true,
        },
        key: { type: "positional", description: "Record key", required: true },
        values: {
          type: "boolean",
          description: "Include values in output",
          default: false,
        },
        limit: { type: "string", description: "Maximum revisions to show" },
        json: {
          type: "boolean",
          description: "Output as JSON",
          default: false,
        },
      },
      async run({ args }) {
        const ctx = await resolveContext();
        const recordType = args.type as string;
        const key = args.key as string;
        const limit = args.limit ? Number(args.limit) : 20;

        const page = await withSpinner("Fetching history...", () =>
          ctx.record.listRecordHistory(recordType, key, {
            limit,
            includeValues: Boolean(args.values),
          }),
        );

        if (args.json) {
          printJson({
            ok: true,
            items: page.items,
            meta: {
              total: page.total,
              limit,
              next_cursor: page.next_cursor,
            },
          });
          return;
        }

        if (page.items.length === 0) {
          console.log("No history found.");
          return;
        }

        renderTable(
          page.items.map((item) => ({
            revision: item.revision,
            operation: item.operation,
            actor: item.actor,
            created: formatTimestamp(item.created_at),
            sha256: item.value_sha256.substring(0, 12),
          })),
          [
            { key: "revision", label: "Rev" },
            { key: "operation", label: "Operation" },
            { key: "actor", label: "Actor" },
            { key: "created", label: "Created" },
            { key: "sha256", label: "SHA256" },
          ],
        );
      },
    }),

    export: defineCommand({
      meta: { name: "export", description: "Export records to files" },
      args: {
        type: {
          type: "positional",
          description: "Record type (or omit with --all)",
        },
        "output-dir": {
          type: "string",
          description: "Output directory (default: current directory)",
        },
        format: { type: "string", description: "Output format: json or yaml" },
        all: {
          type: "boolean",
          description: "Export all record types",
          default: false,
        },
      },
      async run({ args }) {
        const ctx = await resolveContext();
        const outputDir = (args["output-dir"] as string) ?? ".";

        // Determine types to export
        let types: string[];
        if (args.all) {
          types = await ctx.record.listRecordTypesInUse();
        } else {
          const recordType = args.type as string | undefined;
          if (!recordType) {
            console.error("Error: specify a record type or use --all");
            process.exit(1);
            return;
          }
          types = [recordType];
        }

        for (const recordType of types) {
          // Determine format for this type
          let outputFormat = args.format as string | undefined;
          if (!outputFormat) {
            const typeDef = await fetchRecordTypeDef(ctx.schema, recordType);
            outputFormat = typeDef?.format ?? "json";
          }
          const ext = outputFormat === "yaml" ? ".yaml" : ".json";

          // List all records of this type
          const listResult = await ctx.record.listRecords({ type: recordType });

          for (const item of listResult.items) {
            // Fetch full record
            const record = await ctx.record.getRecord(recordType, item.key);
            if (!record) continue;

            // Build output path from key segments using path.join for safety
            const segments = item.key.split("/");
            const fileName = segments.pop() ?? item.key;
            const subDir =
              segments.length > 0
                ? join(outputDir, recordType, ...segments)
                : join(outputDir, recordType);
            mkdirSync(subDir, { recursive: true });
            const outPath = join(subDir, `${fileName}${ext}`);

            const content =
              outputFormat === "yaml"
                ? yaml.stringify(record.value)
                : `${JSON.stringify(record.value, null, 2)}\n`;

            writeFileSync(outPath, content, "utf-8");
            console.log(`Exported ${recordType}/${item.key} -> ${outPath}`);
          }
        }
      },
    }),

    types: defineCommand({
      meta: { name: "types", description: "List record types" },
      args: {
        "in-use": {
          type: "boolean",
          description: "Show only types with existing records",
          default: false,
        },
        json: {
          type: "boolean",
          description: "Output as JSON",
          default: false,
        },
      },
      async run({ args }) {
        const ctx = await resolveContext();

        // RecordBackend exposes a single types method (the in-use ∪ declared
        // set, sorted). The `--in-use` flag is preserved for compatibility but
        // resolves through the same backend method in both local and remote
        // mode.
        const typesToShow = await withSpinner("Fetching types...", () =>
          ctx.record.listRecordTypesInUse(),
        );

        if (args.json) {
          printJson({ ok: true, types: typesToShow });
          return;
        }

        if (typesToShow.length === 0) {
          console.log("No record types found.");
          return;
        }

        for (const t of typesToShow) {
          console.log(t);
        }
      },
    }),
  },
});
