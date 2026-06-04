import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { defineCommand } from "citty";
import { resolveContext } from "../context";
import { printJson, tsToIso } from "../lib/output";

export default defineCommand({
  meta: { name: "index", description: "Manage index artifacts" },
  subCommands: {
    create: defineCommand({
      meta: {
        name: "create",
        description: "Create an index artifact",
      },
      args: {
        file: {
          type: "positional",
          description: "File path for index content",
          required: true,
        },
        kind: {
          type: "string",
          description: "Artifact kind (e.g. index, lesson-index)",
          default: "index",
        },
        resource: {
          type: "string",
          description: "Resource ID (optional)",
        },
        json: {
          type: "boolean",
          description: "Output as JSON",
          default: false,
        },
      },
      async run({ args }) {
        const ctx = await resolveContext();
        const filePath = args.file as string;
        const content = readFileSync(filePath);
        const fileName = basename(filePath);

        const result = await ctx.artifact.put({
          key: fileName,
          body: content.buffer as ArrayBuffer,
          sha256: "",
          metadata: {},
          contentType: "application/octet-stream",
          kind: args.kind as string,
          resource: args.resource as string | undefined,
          flavor: "index",
        });
        if (args.json) {
          printJson({ ok: true, key: result.key, bytes: result.bytes });
          return;
        }
        console.log(
          `Created index artifact: ${result.key} (${result.bytes} bytes)`,
        );
      },
    }),
    "add-entry": defineCommand({
      meta: {
        name: "add-entry",
        description: "Add an entry to an index",
      },
      args: {
        indexKey: {
          type: "positional",
          description: "Index artifact key",
          required: true,
        },
        entryKey: {
          type: "positional",
          description: "Entry artifact key",
          required: true,
        },
        json: {
          type: "boolean",
          description: "Output as JSON",
          default: false,
        },
      },
      async run({ args }) {
        const ctx = await resolveContext();
        if (!ctx.artifact.addRelationship) {
          console.error(
            "Error: index add-entry is not supported in this backend mode",
          );
          process.exit(1);
        }
        await ctx.artifact.addRelationship(
          args.entryKey as string,
          { to_key: args.indexKey as string },
          "entry-of",
        );
        if (args.json) {
          printJson({ ok: true });
          return;
        }
        console.log(`Added entry: ${args.entryKey} -> ${args.indexKey}`);
      },
    }),
    "list-entries": defineCommand({
      meta: {
        name: "list-entries",
        description: "List entries in an index",
      },
      args: {
        indexKey: {
          type: "positional",
          description: "Index artifact key",
          required: true,
        },
        json: {
          type: "boolean",
          description: "Output as JSON",
          default: false,
        },
      },
      async run({ args }) {
        const ctx = await resolveContext();
        if (!ctx.artifact.listIndexEntries) {
          console.error(
            "Error: index list-entries is not supported in this backend mode",
          );
          process.exit(1);
        }
        const entries = await ctx.artifact.listIndexEntries(
          args.indexKey as string,
        );

        if (args.json) {
          printJson({
            entries: entries.map((entry) => ({
              ...entry,
              produced_at: tsToIso(entry.produced_at),
              expires_at: entry.expires_at ? tsToIso(entry.expires_at) : null,
            })),
          });
          return;
        }

        if (entries.length === 0) {
          console.log("No entries found.");
          return;
        }

        for (const entry of entries) {
          const status = entry.exists ? "" : " [expired]";
          const res = entry.resource ?? "(source)";
          console.log(
            `${entry.r2_key}  ${entry.kind}  ${res}  ${entry.sha256.slice(0, 12)}...  ${entry.produced_at}${status}`,
          );
        }
      },
    }),
  },
});
