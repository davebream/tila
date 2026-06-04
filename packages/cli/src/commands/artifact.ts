import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { defineCommand } from "citty";
import { resolveContext } from "../context";
import { printJson, renderTable, tsToIso } from "../lib/output";

export default defineCommand({
  meta: { name: "artifact", description: "Manage artifacts" },
  subCommands: {
    put: defineCommand({
      meta: { name: "put", description: "Upload an artifact" },
      args: {
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

        const result = await ctx.artifact.put({
          key: fileName, // placeholder -- Worker derives the canonical key
          body: content.buffer as ArrayBuffer,
          sha256: "", // Worker recomputes SHA-256
          metadata: {},
          contentType,
          kind: args.kind as string,
          resource: args.resource as string | undefined,
          fence: args.fence ? Number(args.fence) : undefined,
        });

        if (args.json) {
          printJson({
            ok: true,
            key: result.key,
            bytes: result.bytes,
          });
          return;
        }
        console.log(`Uploaded artifact: ${result.key} (${result.bytes} bytes)`);
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
        const ctx = await resolveContext();
        const key = args.key as string;
        const result = await ctx.artifact.get(key);

        if (!result) {
          console.error(`Artifact not found: ${key}`);
          process.exit(1);
        }

        const buffer = Buffer.from(
          await new Response(result.body).arrayBuffer(),
        );

        if (args.output) {
          writeFileSync(args.output as string, buffer);
          console.error(
            `Downloaded ${buffer.byteLength} bytes (${result.contentType}) to ${args.output}`,
          );
        } else {
          process.stdout.write(buffer);
          console.error(`Content-Type: ${result.contentType}`);
        }
      },
    }),
    write: defineCommand({
      meta: {
        name: "write",
        description: "Write text content as an artifact",
      },
      args: {
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
        json: {
          type: "boolean",
          description: "Output as JSON",
          default: false,
        },
      },
      async run({ args }) {
        const ctx = await resolveContext();
        if (!ctx.artifact.writeText) {
          console.error(
            "Error: artifact write is not supported in this backend mode",
          );
          process.exit(1);
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
          console.error("Error: provide --text or pipe content via stdin");
          process.exit(1);
        }

        const result = await ctx.artifact.writeText(content, {
          kind: args.kind as string,
          mimeType: args.mimeType as string,
          resource: args.resource as string | undefined,
          fence: args.fence ? Number(args.fence) : undefined,
        });

        if (args.json) {
          printJson({ ok: true, key: result.key, bytes: result.bytes });
          return;
        }
        console.log(`Written artifact: ${result.key} (${result.bytes} bytes)`);
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
        json: {
          type: "boolean",
          description: "Output as JSON with metadata",
          default: false,
        },
      },
      async run({ args }) {
        const ctx = await resolveContext();
        if (!ctx.artifact.readText) {
          console.error(
            "Error: artifact cat is not supported in this backend mode",
          );
          process.exit(1);
        }
        const key = args.key as string;
        const result = await ctx.artifact.readText(key);
        if (!result) {
          console.error(`Artifact not found: ${key}`);
          process.exit(1);
        }

        if (args.json) {
          printJson({
            key,
            content: result.content,
            mime_type: result.mimeType,
          });
          return;
        }
        process.stdout.write(result.content);
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
        json: {
          type: "boolean",
          description: "Output as JSON",
          default: false,
        },
      },
      async run({ args }) {
        const ctx = await resolveContext();
        if (!ctx.artifact.listPointers) {
          console.error(
            "Error: artifact list is not supported in this backend mode",
          );
          process.exit(1);
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
          console.log("No artifacts found.");
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
                "Error: artifact rel is not supported in this backend mode",
              );
              process.exit(1);
            }
            const toKeyOrUri: { to_key?: string; to_uri?: string } = {};
            if (args.toKey) {
              toKeyOrUri.to_key = args.toKey as string;
            } else if (args.toUri) {
              toKeyOrUri.to_uri = args.toUri as string;
            } else {
              console.error(
                "Error: either a positional toKey or --to-uri is required",
              );
              process.exit(1);
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
            console.log(
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
            json: {
              type: "boolean",
              description: "Output as JSON",
              default: false,
            },
          },
          async run({ args }) {
            const ctx = await resolveContext();
            if (!ctx.artifact.listRelationships) {
              console.error(
                "Error: artifact rel list is not supported in this backend mode",
              );
              process.exit(1);
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
              console.log("No relationships found.");
              return;
            }
            for (const rel of rels) {
              const target = rel.to_key ?? rel.to_uri ?? "(none)";
              console.log(
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
        json: {
          type: "boolean",
          description: "Output as JSON",
          default: false,
        },
      },
      async run({ args }) {
        const ctx = await resolveContext();
        if (!ctx.artifact.getLatest) {
          console.error(
            "Error: artifact latest is not supported in this backend mode",
          );
          process.exit(1);
        }
        const pointer = await ctx.artifact.getLatest(
          args.kind as string,
          args.resource as string,
        );
        if (!pointer) {
          if (args.json) {
            printJson({ ok: false, pointer: null });
            return;
          }
          console.log("No artifact found.");
          return;
        }
        if (args.json) {
          printJson({ ok: true, pointer });
          return;
        }
        console.log(JSON.stringify(pointer, null, 2));
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
        json: {
          type: "boolean",
          description: "Output raw JSON response",
          default: false,
        },
      },
      async run({ args }) {
        const ctx = await resolveContext();
        if (!ctx.artifact.grepArtifacts) {
          console.error(
            "Error: artifact grep is not supported in this backend mode",
          );
          process.exit(1);
        }
        const response = await ctx.artifact.grepArtifacts({
          pattern: args.pattern as string,
          kind: args.kind as string | undefined,
          resource: args.resource as string | undefined,
          regex: args.regex as boolean,
          limit: args.limit ? Number(args.limit) : undefined,
        });

        if (args.json) {
          console.log(JSON.stringify(response, null, 2));
          return;
        }

        if (response.truncated) {
          console.error(
            "Warning: results truncated — narrow with --kind/--resource or raise --limit",
          );
        }

        if (response.results.length === 0) {
          console.log("No results found.");
          return;
        }

        for (const result of response.results) {
          const lines = result.lines;
          for (let i = 0; i < lines.length; i++) {
            const { line, text } = lines[i];
            const isLast = i === lines.length - 1;
            const suffix = isLast && result.truncated ? " (truncated)" : "";
            console.log(`${result.key}:${line}: ${text}${suffix}`);
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
        json: {
          type: "boolean",
          description: "Output as JSON",
          default: false,
        },
      },
      async run({ args }) {
        const ctx = await resolveContext();
        if (!ctx.artifact.searchArtifacts) {
          console.error(
            "Error: artifact search is not supported in this backend mode",
          );
          process.exit(1);
        }
        const results = await ctx.artifact.searchArtifacts({
          q: args.query as string,
          kind: args.kind as string | undefined,
          resource: args.resource as string | undefined,
          limit: args.limit ? Number(args.limit) : undefined,
        });

        if (args.json) {
          console.log(JSON.stringify({ results }, null, 2));
          return;
        }

        if (results.length === 0) {
          console.log("No results found.");
          return;
        }

        for (const r of results) {
          const title = r.title ? `  ${r.title}` : "";
          const snippet = r.snippet ? `\n  ${r.snippet}` : "";
          console.log(`${r.r2_key}  ${r.kind}${title}${snippet}`);
        }
      },
    }),
  },
});
