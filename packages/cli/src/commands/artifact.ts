import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { ArtifactReviewRequestSchema } from "@tila/schemas";
import { defineCommand } from "citty";
import { resolveContext } from "../context";
import {
  boundedItems,
  currentOutput,
  diagnostic,
  exit,
  failWithCliError,
  jsonArg,
  outputText,
  printJson,
  printJsonError,
  rawOutput,
  renderTable,
  tsToIso,
} from "../lib/output";

const versionArgs = {
  lineage: {
    type: "string" as const,
    description: "Explicit artifact lineage ID",
  },
  "lineage-fence": {
    type: "string" as const,
    description: "Fence for artifact:<lineage>",
  },
  tags: {
    type: "string" as const,
    description: "Comma-separated tags (empty clears tags)",
  },
  "idempotency-key": {
    type: "string" as const,
    description: "Reuse this key when retrying the same write",
  },
};
function versionOptions(args: Record<string, unknown>) {
  return {
    lineageId: args.lineage as string | undefined,
    lineageFence:
      args["lineage-fence"] === undefined
        ? undefined
        : Number(args["lineage-fence"]),
    tags:
      args.tags === undefined
        ? undefined
        : String(args.tags).split(",").filter(Boolean),
    idempotencyKey: args["idempotency-key"] as string | undefined,
  };
}

export default defineCommand({
  meta: { name: "artifact", description: "Manage artifacts" },
  subCommands: {
    review: defineCommand({
      meta: {
        name: "review",
        description:
          "Record an explicit artifact review (a hash does not establish trust)",
      },
      args: {
        key: { type: "positional", required: true },
        decision: {
          type: "string",
          required: true,
          description: "trusted, rejected, superseded, or revoked",
        },
        "expected-review-revision": {
          type: "string",
          required: true,
          description: "Current review revision (0 before the first review)",
        },
        reason: { type: "string" },
        "idempotency-key": versionArgs["idempotency-key"],
        ...jsonArg,
      },
      async run({ args }) {
        try {
          const { artifact } = await resolveContext();
          if (!artifact.review)
            throw new Error("Artifact review is unavailable in this backend");
          const request = ArtifactReviewRequestSchema.parse({
            decision: args.decision,
            expected_review_revision: Number(args["expected-review-revision"]),
            reason: args.reason,
          });
          printJson(
            await artifact.review(args.key, {
              ...request,
              idempotencyKey: args["idempotency-key"],
            }),
          );
        } catch (err) {
          failWithCliError(err, Boolean(args.json));
        }
      },
    }),
    reviews: defineCommand({
      meta: { name: "reviews", description: "Read artifact review history" },
      args: {
        key: { type: "positional", required: true },
        limit: { type: "string" },
        "before-revision": { type: "string" },
        ...jsonArg,
      },
      async run({ args }) {
        try {
          const { artifact } = await resolveContext();
          if (!artifact.reviews)
            throw new Error("Artifact reviews are unavailable in this backend");
          printJson(
            await artifact.reviews(args.key, {
              limit: args.limit === undefined ? undefined : Number(args.limit),
              before_revision:
                args["before-revision"] === undefined
                  ? undefined
                  : Number(args["before-revision"]),
            }),
          );
        } catch (err) {
          failWithCliError(err, Boolean(args.json));
        }
      },
    }),
    history: defineCommand({
      meta: { name: "history", description: "List artifact revisions" },
      args: {
        key: {
          type: "positional",
          required: true,
          description: "Artifact key",
        },
        limit: {
          type: "string",
          description: "Page size (1–200)",
          default: "20",
        },
        cursor: {
          type: "string",
          description: "Cursor from the previous page",
        },
        ...jsonArg,
      },
      async run({ args }) {
        try {
          const { artifact } = await resolveContext();
          if (!artifact.history)
            throw new Error("Artifact history is unavailable in this backend");
          const result = await artifact.history(args.key, {
            limit: Number(args.limit),
            cursor: args.cursor,
          });
          if (args.json) {
            printJson(result);
            return;
          }
          renderTable(
            result.items.map((p) => ({
              revision: p.revision ?? "legacy",
              key: p.r2_key,
              bytes: p.bytes,
              produced_at: tsToIso(p.produced_at),
              tags: p.tags.join(","),
              unavailable: Boolean(p.tombstoned || p.blob_deleted_at),
            })),
            [
              { key: "revision", label: "Revision" },
              { key: "key", label: "Key" },
              { key: "bytes", label: "Bytes" },
              { key: "produced_at", label: "Created" },
              { key: "tags", label: "Tags" },
              { key: "unavailable", label: "Unavailable" },
            ],
          );
          if (result.meta.next_cursor)
            outputText(`Next cursor: ${result.meta.next_cursor}`);
        } catch (err) {
          failWithCliError(err, Boolean(args.json));
        }
      },
    }),
    restore: defineCommand({
      meta: {
        name: "restore",
        description: "Append a revision from an existing artifact",
      },
      args: {
        key: {
          type: "positional",
          required: true,
          description: "Source artifact key",
        },
        fence: {
          type: "string",
          required: true,
          description: "Fence for artifact:<lineage>",
        },
        lineage: versionArgs.lineage,
        tags: versionArgs.tags,
        "idempotency-key": versionArgs["idempotency-key"],
        ...jsonArg,
      },
      async run({ args }) {
        try {
          const { artifact } = await resolveContext();
          if (!artifact.restore)
            throw new Error("Artifact restore is unavailable in this backend");
          const opts = versionOptions(args);
          const result = await artifact.restore(args.key, {
            fence: Number(args.fence),
            lineage_id: opts.lineageId,
            tags: opts.tags,
            idempotencyKey: opts.idempotencyKey,
          });
          if (args.json) {
            printJson(result);
            return;
          }
          outputText(
            `Restored revision ${result.pointer.revision}: ${result.key}`,
          );
        } catch (err) {
          failWithCliError(err, Boolean(args.json));
        }
      },
    }),
    put: defineCommand({
      meta: { name: "put", description: "Upload an artifact" },
      args: {
        ...versionArgs,
        file: { type: "positional", description: "File path", required: true },
        kind: { type: "string", description: "Artifact kind", required: true },
        resource: {
          type: "string",
          description: "Resource ID (omit for source artifacts)",
        },
        fence: {
          type: "string",
          description: "Fencing token (required for produced artifacts)",
        },
        ...jsonArg,
      },
      async run({ args }) {
        const ctx = await resolveContext();
        const filePath = args.file as string;
        const content = readFileSync(filePath);
        const fileName = basename(filePath);

        // Guess content type from extension
        const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
        const contentTypeMap: Record<string, string> = {
          md: "text/markdown",
          txt: "text/plain",
          json: "application/json",
          yaml: "text/yaml",
          yml: "text/yaml",
          toml: "text/toml",
          html: "text/html",
          csv: "text/csv",
        };
        const contentType = contentTypeMap[ext] ?? "application/octet-stream";

        // A stale/invalid fence is rejected by the backend (FenceError locally,
        // stale-fence TilaApiError remotely). Surface it as a clean one-line
        // error instead of leaking a bundled stack trace.
        try {
          const result = await ctx.artifact.put({
            ...versionOptions(args),
            key: fileName, // placeholder -- Worker derives the canonical key
            body: new Uint8Array(content).buffer,
            sha256: "", // Worker recomputes SHA-256
            metadata: {},
            contentType,
            kind: args.kind as string,
            resource: args.resource as string | undefined,
            fence: args.fence ? Number(args.fence) : undefined,
          });

          const deduplicated = result.deduplicated === true;

          if (args.json) {
            printJson({
              ok: true,
              key: result.key,
              bytes: result.bytes,
              deduplicated,
            });
            return;
          }
          const verb = deduplicated ? "Deduplicated" : "Uploaded";
          outputText(`${verb} artifact: ${result.key} (${result.bytes} bytes)`);
        } catch (err) {
          failWithCliError(err, Boolean(args.json));
        }
      },
    }),
    get: defineCommand({
      meta: { name: "get", description: "Download an artifact" },
      args: {
        key: {
          type: "positional",
          description: "Artifact key (e.g. produced/T-142/abc123.md)",
          required: true,
        },
        output: {
          type: "string",
          description: "Output file path (default: stdout)",
        },
      },
      async run({ args }) {
        if (currentOutput()?.json && !args.output)
          printJsonError(
            "JSON downloads require --output <file>",
            "invalid-argument",
          );
        const ctx = await resolveContext();
        const key = args.key as string;
        const result = await ctx.artifact.get(key);

        if (!result) {
          diagnostic(`Artifact not found: ${key}`);
          exit(1);
        }

        const pointer = ctx.artifact.meta
          ? (await ctx.artifact.meta(key)).pointer
          : undefined;
        if (pointer) diagnostic(JSON.stringify({ artifact_metadata: pointer }));
        const buffer = Buffer.from(
          await new Response(result.body).arrayBuffer(),
        );

        if (args.output) {
          writeFileSync(args.output as string, buffer);
          if (currentOutput()?.json) {
            printJson({
              key,
              bytes: buffer.byteLength,
              content_type: result.contentType,
              output: args.output,
              pointer,
            });
            return;
          }
          diagnostic(
            `Downloaded ${buffer.byteLength} bytes (${result.contentType}) to ${args.output}`,
          );
        } else {
          rawOutput(buffer);
          diagnostic(`Content-Type: ${result.contentType}`);
        }
      },
    }),
    write: defineCommand({
      meta: {
        name: "write",
        description: "Write text content as an artifact",
      },
      args: {
        ...versionArgs,
        kind: {
          type: "string",
          description: "Artifact kind (e.g. plan, report, lesson)",
          required: true,
        },
        text: {
          type: "string",
          description: "Inline text content (omit to read from stdin)",
        },
        resource: {
          type: "string",
          description: "Resource ID (omit for source artifacts)",
        },
        fence: {
          type: "string",
          description: "Fencing token (required for produced artifacts)",
        },
        mimeType: {
          type: "string",
          description: "MIME type (default: text/markdown)",
          default: "text/markdown",
        },
        ...jsonArg,
      },
      async run({ args }) {
        const ctx = await resolveContext();
        if (!ctx.artifact.writeText) {
          diagnostic(
            "Error: artifact write is not supported in this backend mode",
          );
          exit(1);
        }

        let content: string;
        if (args.text) {
          content = args.text as string;
        } else if (!process.stdin.isTTY) {
          const chunks: Buffer[] = [];
          for await (const chunk of process.stdin) {
            chunks.push(
              Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string),
            );
          }
          content = Buffer.concat(chunks).toString("utf-8");
        } else {
          diagnostic("Error: provide --text or pipe content via stdin");
          exit(1);
        }

        const result = await ctx.artifact.writeText(content, {
          ...versionOptions(args),
          kind: args.kind as string,
          mimeType: args.mimeType as string,
          resource: args.resource as string | undefined,
          fence: args.fence ? Number(args.fence) : undefined,
        });

        if (args.json) {
          printJson({ ok: true, ...result });
          return;
        }
        outputText(`Written artifact: ${result.key} (${result.bytes} bytes)`);
      },
    }),
    cat: defineCommand({
      meta: { name: "cat", description: "Read artifact text to stdout" },
      args: {
        key: {
          type: "positional",
          description: "Artifact key",
          required: true,
        },
        ...jsonArg,
      },
      async run({ args }) {
        const ctx = await resolveContext();
        if (!ctx.artifact.readText) {
          diagnostic(
            "Error: artifact cat is not supported in this backend mode",
          );
          exit(1);
        }
        const key = args.key as string;
        const result = await ctx.artifact.readText(key);
        if (!result) {
          diagnostic(`Artifact not found: ${key}`);
          exit(1);
        }

        if (args.json) {
          printJson({
            key,
            content: result.content,
            pointer: result.pointer,
            mime_type: result.mimeType,
          });
          return;
        }
        diagnostic(
          JSON.stringify({
            artifact_metadata: result.pointer ?? {
              provenance: null,
              review: { state: "unreviewed" },
            },
          }),
        );
        rawOutput(result.content);
      },
    }),
    list: defineCommand({
      meta: { name: "list", description: "List artifact pointers" },
      args: {
        resource: {
          type: "string",
          description: "Filter by resource ID",
        },
        kind: {
          type: "string",
          description: "Filter by artifact kind",
        },
        ...jsonArg,
      },
      async run({ args }) {
        const ctx = await resolveContext();
        if (!ctx.artifact.listPointers) {
          diagnostic(
            "Error: artifact list is not supported in this backend mode",
          );
          exit(1);
        }
        const pointers = await ctx.artifact.listPointers({
          resource: args.resource as string | undefined,
          kind: args.kind as string | undefined,
        });
        if (args.json) {
          printJson({ pointers });
          return;
        }
        if (pointers.length === 0) {
          outputText("No artifacts found.");
          return;
        }
        renderTable(
          pointers.map((p) => ({
            key: p.r2_key,
            kind: p.kind,
            resource: p.resource ?? "(source)",
            bytes: p.bytes,
            sha256: `${p.sha256.slice(0, 12)}...`,
          })),
          [
            { key: "key", label: "Key" },
            { key: "kind", label: "Kind" },
            { key: "resource", label: "Resource" },
            { key: "bytes", label: "Bytes" },
            { key: "sha256", label: "SHA256" },
          ],
        );
      },
    }),
    rel: defineCommand({
      meta: {
        name: "rel",
        description: "Manage artifact relationships",
      },
      subCommands: {
        add: defineCommand({
          meta: {
            name: "add",
            description: "Add a relationship between artifacts",
          },
          args: {
            fromKey: {
              type: "positional",
              description: "Source artifact key",
              required: true,
            },
            toKey: {
              type: "positional",
              description: "Target artifact key (or --to-uri for external)",
              required: false,
            },
            type: {
              type: "string",
              description:
                "Relationship type (e.g. references, supersedes, derived-from)",
              required: true,
            },
            toUri: {
              type: "string",
              description:
                "External URI target (alternative to positional toKey)",
            },
            ...jsonArg,
          },
          async run({ args }) {
            const ctx = await resolveContext();
            if (!ctx.artifact.addRelationship) {
              diagnostic(
                "Error: artifact rel is not supported in this backend mode",
              );
              exit(1);
            }
            const toKeyOrUri: { to_key?: string; to_uri?: string } = {};
            if (args.toKey) {
              toKeyOrUri.to_key = args.toKey as string;
            } else if (args.toUri) {
              toKeyOrUri.to_uri = args.toUri as string;
            } else {
              diagnostic(
                "Error: either a positional toKey or --to-uri is required",
              );
              exit(1);
            }
            await ctx.artifact.addRelationship(
              args.fromKey as string,
              toKeyOrUri,
              args.type as string,
            );
            if (args.json) {
              printJson({ ok: true });
              return;
            }
            const target = (args.toKey as string) || (args.toUri as string);
            outputText(
              `Added relationship: ${args.fromKey} -[${args.type}]-> ${target}`,
            );
          },
        }),
        list: defineCommand({
          meta: {
            name: "list",
            description: "List relationships for an artifact",
          },
          args: {
            key: {
              type: "positional",
              description: "Artifact R2 key",
              required: true,
            },
            ...jsonArg,
          },
          async run({ args }) {
            const ctx = await resolveContext();
            if (!ctx.artifact.listRelationships) {
              diagnostic(
                "Error: artifact rel list is not supported in this backend mode",
              );
              exit(1);
            }
            const rels = await ctx.artifact.listRelationships(
              args.key as string,
            );
            if (args.json) {
              printJson({
                relationships: rels.map((rel) => ({
                  ...rel,
                  created_at: tsToIso(rel.created_at),
                })),
              });
              return;
            }
            if (rels.length === 0) {
              outputText("No relationships found.");
              return;
            }
            for (const rel of rels) {
              const target = rel.to_key ?? rel.to_uri ?? "(none)";
              outputText(
                `${rel.type}  ${target}  ${new Date(rel.created_at).toISOString()}`,
              );
            }
          },
        }),
      },
    }),
    latest: defineCommand({
      meta: {
        name: "latest",
        description: "Get the latest artifact of a given kind for a resource",
      },
      args: {
        kind: {
          type: "string",
          description: "Artifact kind (e.g. plan, design)",
          required: true,
        },
        resource: {
          type: "string",
          description: "Resource ID",
          required: true,
        },
        ...jsonArg,
      },
      async run({ args }) {
        const ctx = await resolveContext();
        if (!ctx.artifact.getLatest) {
          diagnostic(
            "Error: artifact latest is not supported in this backend mode",
          );
          exit(1);
        }
        const pointer = await ctx.artifact.getLatest(
          args.kind as string,
          args.resource as string,
        );
        if (!pointer) {
          if (args.json) {
            printJson({ found: false, pointer: null });
            return;
          }
          outputText("No artifact found.");
          return;
        }
        if (args.json) {
          printJson({ ok: true, pointer });
          return;
        }
        outputText(JSON.stringify(pointer, null, 2));
      },
    }),
    grep: defineCommand({
      meta: {
        name: "grep",
        description:
          "Search artifact content by exact substring or bounded regex. Prints key:line: text per matching line. col is a character offset (ASCII-accurate); not a raw-byte offset.",
      },
      args: {
        pattern: {
          type: "positional",
          description: "Pattern to search for (literal substring by default)",
          required: true,
        },
        kind: {
          type: "string",
          description: "Filter by artifact kind (e.g. plan, log)",
        },
        resource: {
          type: "string",
          description: "Filter by resource ID",
        },
        regex: {
          type: "boolean",
          description:
            "Interpret pattern as bounded regex (no backreferences, no lookaround, no nested unbounded quantifiers)",
          default: false,
        },
        limit: {
          type: "string",
          description:
            "Maximum candidate artifacts to scan (default: 50, max: 100)",
        },
        ...jsonArg,
      },
      async run({ args }) {
        const ctx = await resolveContext();
        if (!ctx.artifact.grepArtifacts) {
          diagnostic(
            "Error: artifact grep is not supported in this backend mode",
          );
          exit(1);
        }
        const response = await ctx.artifact.grepArtifacts({
          pattern: args.pattern as string,
          kind: args.kind as string | undefined,
          resource: args.resource as string | undefined,
          regex: args.regex as boolean,
          limit: args.limit ? Number(args.limit) : undefined,
        });

        if (args.json) {
          printJson(response);
          return;
        }

        if (response.truncated) {
          diagnostic(
            "Warning: results truncated — narrow with --kind/--resource or raise --limit",
          );
        }

        if (response.results.length === 0) {
          outputText("No results found.");
          return;
        }

        for (const result of boundedItems(response.results)) {
          const lines = result.lines;
          for (let i = 0; i < lines.length; i++) {
            const { line, text } = lines[i];
            const isLast = i === lines.length - 1;
            const suffix = isLast && result.truncated ? " (truncated)" : "";
            outputText(`${result.key}:${line}: ${text}${suffix}`);
          }
        }
      },
    }),
    search: defineCommand({
      meta: {
        name: "search",
        description: "Full-text search across indexed artifacts",
      },
      args: {
        query: {
          type: "positional",
          description:
            "Search query (FTS5 syntax; lexical match, per-project only)",
          required: true,
        },
        kind: {
          type: "string",
          description: "Filter by artifact kind (e.g. lesson, plan)",
        },
        resource: {
          type: "string",
          description: "Filter by resource ID",
        },
        limit: {
          type: "string",
          description:
            "Maximum number of results to return (default: 20, max: 100)",
        },
        ...jsonArg,
      },
      async run({ args }) {
        const ctx = await resolveContext();
        if (!ctx.artifact.searchArtifacts) {
          diagnostic(
            "Error: artifact search is not supported in this backend mode",
          );
          exit(1);
        }
        const results = await ctx.artifact.searchArtifacts({
          q: args.query as string,
          kind: args.kind as string | undefined,
          resource: args.resource as string | undefined,
          limit: args.limit ? Number(args.limit) : undefined,
        });

        if (args.json) {
          printJson({ results });
          return;
        }

        if (results.length === 0) {
          outputText("No results found.");
          return;
        }

        for (const r of boundedItems(results)) {
          const title = r.title ? `  ${r.title}` : "";
          const snippet = r.snippet ? `\n  ${r.snippet}` : "";
          outputText(`${r.r2_key}  ${r.kind}${title}${snippet}`);
        }
      },
    }),
  },
});
