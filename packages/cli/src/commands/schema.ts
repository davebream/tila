import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import {
  type DefinitionFormat,
  type DefinitionImportMode,
  compareDefinitionUnits,
  definitionFormatFromName,
  diffSchemas,
  parseDefinitionDocument,
  parseSchemaToml,
  planDefinitionImport,
} from "@tila/core";
import {
  readDefinitionFile,
  renderDefinitionExport,
} from "@tila/core/definition-yaml";
import { type TilaSchemaToml, TilaSchemaTomlSchema } from "@tila/schemas";
import { defineCommand } from "citty";
import { parse as parseTOML } from "smol-toml";
import { resolveContext } from "../context";
import {
  diagnostic,
  exit,
  jsonArg,
  outputText,
  printJson,
  printJsonError,
  rawOutput,
  warning,
} from "../lib/output";
import { loadComposedSchema } from "../lib/schema-loader";
import {
  cliError,
  currentDefinition,
  definitionRevisionFlag,
  describeSchemaChange,
  formatDefinitionErrors,
} from "../lib/schema-transfer";
import { VERSION as CLI_VERSION } from "../version";

const MODES = ["merge", "replace"] as const;
const FORMATS = ["toml", "yaml"] as const;

function formatArg(raw: unknown): DefinitionFormat | undefined {
  if (raw === undefined) return undefined;
  if (!FORMATS.includes(raw as DefinitionFormat))
    throw cliError("invalid-argument", "--format must be toml or yaml");
  return raw as DefinitionFormat;
}

function list(label: string, paths: readonly string[]) {
  if (paths.length === 0) return;
  outputText(`${label} (${paths.length}):`);
  for (const path of paths) outputText(`  ${path}`);
}

/** Read the import source: a named file, or the composed *.schema.toml files. */
function importSource(file: string | undefined): {
  text: string;
  label: string;
  filename?: string;
  format?: DefinitionFormat;
} {
  if (file) {
    if (!existsSync(file)) throw cliError("not-found", `No such file: ${file}`);
    return { text: readFileSync(file, "utf8"), label: file, filename: file };
  }
  const loaded = loadComposedSchema();
  if (!loaded.ok) {
    if (loaded.code === "FILE_NOT_FOUND")
      throw cliError(
        "not-found",
        "No file given and no *.schema.toml in the current directory",
        "Pass the file to import: tila schema import <file>",
      );
    throw cliError(
      "definition-invalid",
      `Schema parse error:\n${formatDefinitionErrors(loaded.errors)}`,
    );
  }
  if (loaded.warnings.length > 0)
    warning(
      `Schema composition warnings:\n${loaded.warnings
        .map((w) => `  ${w.message} (${w.fragments.join(", ")})`)
        .join("\n")}`,
    );
  return {
    text: loaded.definition,
    label: "*.schema.toml",
    filename: "x.toml",
  };
}

/**
 * Parse the current applied schema definition into a TilaSchemaToml.
 *
 * `SchemaBackend.getCurrentSchema().definition` is TOML for the local backend
 * (stored verbatim by `schemaOps.applySchema`) but a JSON string for the remote
 * backend (`RemoteBackend.getCurrentSchema` JSON-stringifies the Worker's
 * parsed schema). Try JSON first, then fall back to TOML — mirroring
 * `template.ts`'s `fetchSchemaToml`. Returns null when no schema is applied.
 */
function parseCurrentDefinition(definition: string | null): TilaSchemaToml {
  if (!definition) {
    // No schema applied yet → diff against an empty schema (everything is "added").
    return TilaSchemaTomlSchema.parse({ schema_version: 1, work_units: {} });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(definition);
  } catch {
    raw = parseTOML(definition);
  }
  return TilaSchemaTomlSchema.parse(raw);
}

export default defineCommand({
  meta: { name: "schema", description: "Manage project schema" },
  subCommands: {
    diff: defineCommand({
      meta: {
        name: "diff",
        description: "Preview schema changes without applying",
      },
      args: {
        ...jsonArg,
      },
      async run({ args }) {
        // Schema diff is computed LOCALLY via the @tila/core `diffSchemas`
        // helper against the current applied schema (`ctx.schema.getCurrentSchema()`),
        // so it works in BOTH local and remote mode with no HTTP round-trip.
        // The DB-aware server-side variant (entityCount enrichment via the Worker
        // /schema/preview route) stays remote-only and is out of scope here; the
        // pure-diff counts are 0 (see @tila/core `diffSchemas`).
        const ctx = await resolveContext();

        // Discover and compose *.schema.toml fragments from current directory
        const loaded = loadComposedSchema();

        if (!loaded.ok) {
          if (loaded.code === "FILE_NOT_FOUND") {
            if (args.json) {
              printJsonError(
                "No schema fragments found in current directory",
                "FILE_NOT_FOUND",
              );
            } else {
              diagnostic(
                "Error: No schema fragments found in current directory. Create a tila.schema.toml file.",
              );
            }
          } else {
            // SCHEMA_PARSE_ERROR
            const msgs = loaded.errors.map((e) => e.message).join("; ");
            if (args.json) {
              printJsonError(
                `Schema parse error: ${msgs}`,
                "SCHEMA_PARSE_ERROR",
              );
            } else {
              diagnostic(`Schema parse error: ${msgs}`);
            }
          }
          exit(1);
          return; // unreachable at runtime; needed so mocked exit in tests doesn't fall through
        }

        const { definition } = loaded;

        // Render advisory warnings as a single block (not N bullets)
        if (loaded.warnings.length > 0) {
          const warningLines = loaded.warnings
            .map((w) => `  ${w.message} (${w.fragments.join(", ")})`)
            .join("\n");
          warning(`Schema composition warnings:\n${warningLines}`);
        }

        // Parse the proposed schema. Surface parse errors the same way the old
        // remote 400 path did (SCHEMA_PARSE_ERROR), so callers see no change in
        // error shape.
        const proposed = parseSchemaToml(definition);
        if (!proposed.ok) {
          const msgs = proposed.errors.map((e) => e.message).join("; ");
          if (args.json) {
            printJsonError(`Schema parse error: ${msgs}`, "SCHEMA_PARSE_ERROR");
          } else {
            diagnostic(`Schema parse error: ${msgs}`);
          }
          exit(1);
          return;
        }

        // Diff the proposed schema against the current applied schema.
        const current = await ctx.schema.getCurrentSchema();
        const previous = parseCurrentDefinition(current.definition);
        const result = diffSchemas(previous, proposed.schema);

        if (args.json) {
          printJson({
            revision: current.revision ?? current.version ?? 0,
            reviewed_definition: definition,
            changes: result.changes,
            autoApplicable: result.autoApplicable,
          });
          return;
        }

        if (result.changes.length === 0) {
          outputText("No changes detected.");
          return;
        }

        outputText(
          `Configuration revision: ${current.revision ?? current.version ?? 0}`,
        );
        outputText("Changes:");
        for (const change of result.changes)
          outputText(describeSchemaChange(change));

        outputText("");
        outputText(`Auto-applicable: ${result.autoApplicable ? "Yes" : "No"}`);
      },
    }),
    show: defineCommand({
      meta: { name: "show", description: "Show current schema" },
      args: {
        ...jsonArg,
      },
      async run({ args }) {
        const { schema } = await resolveContext();
        const record = await schema.getCurrentSchema();
        if (args.json) {
          let schemaObj: unknown = null;
          if (record.definition) {
            try {
              schemaObj = JSON.parse(record.definition);
            } catch {
              schemaObj = record.definition;
            }
          }
          printJson({ version: record.version, schema: schemaObj });
          return;
        }
        outputText(`Schema version: ${record.version ?? "(none)"}`);
        if (record.definition) {
          try {
            outputText(JSON.stringify(JSON.parse(record.definition), null, 2));
          } catch {
            outputText(record.definition);
          }
        }
      },
    }),
    apply: defineCommand({
      meta: { name: "apply", description: "Apply schema changes" },
      args: {
        "expected-revision": {
          type: "string",
          description:
            "Configuration revision from schema diff (0 for initial apply)",
        },
        review: {
          type: "string",
          description:
            "JSON file saved from schema diff --json; binds revision and reviewed definition",
        },
        "idempotency-key": {
          type: "string",
          description: "Stable key when retrying this apply",
        },
        strategy: {
          type: "string",
          description: "Strategy for destructive changes (relax|force)",
        },
        ...jsonArg,
      },
      async run({ args }) {
        const { schema } = await resolveContext();

        // Discover and compose *.schema.toml fragments from current directory
        const loaded = loadComposedSchema();

        if (!loaded.ok) {
          if (loaded.code === "FILE_NOT_FOUND") {
            // Intentional cleanup: the original code had a double-emit in --json mode
            // (printJsonError inside if (args.json) then unconditional console.error
            // below it). Both branches now exit cleanly inside their own branch,
            // matching the clean if/else pattern used in schema diff.
            if (args.json) {
              printJsonError(
                "No schema fragments found in current directory",
                "FILE_NOT_FOUND",
              );
            } else {
              diagnostic(
                "Error: No schema fragments found in current directory. Create a tila.schema.toml file.",
              );
            }
          } else {
            // SCHEMA_PARSE_ERROR
            const msgs = loaded.errors.map((e) => e.message).join("; ");
            if (args.json) {
              printJsonError(
                `Schema parse error: ${msgs}`,
                "SCHEMA_PARSE_ERROR",
              );
            } else {
              diagnostic(`Schema parse error: ${msgs}`);
            }
          }
          exit(1);
          return; // TypeScript: unreachable, but helps narrowing
        }

        const { definition } = loaded;

        // Render advisory warnings as a single block (not N bullets — per cli-output.md)
        if (loaded.warnings.length > 0) {
          const warningLines = loaded.warnings
            .map((w) => `  ${w.message} (${w.fragments.join(", ")})`)
            .join("\n");
          warning(`Schema composition warnings:\n${warningLines}`);
        }

        const review = args.review
          ? (JSON.parse(readFileSync(args.review, "utf8")) as {
              revision: number;
              reviewed_definition: string;
            })
          : undefined;
        const expected =
          args["expected-revision"] === undefined
            ? review?.revision
            : Number(args["expected-revision"]);
        if (
          expected !== undefined &&
          (!Number.isSafeInteger(expected) || expected < 0)
        )
          throw new Error("expected-revision must be a nonnegative integer");
        const result = await schema.applySchema({
          definition,
          strategy: args.strategy as string | undefined,
          ...(expected === undefined ? {} : { expected_revision: expected }),
          ...(review === undefined
            ? {}
            : { reviewed_definition: review.reviewed_definition }),
          ...(args["idempotency-key"] === undefined
            ? {}
            : { idempotency_key: args["idempotency-key"] }),
        });

        if (result.ok) {
          for (const note of result.warnings ?? [])
            warning(
              `${note.code}: ${note.message} Use tila schema import to preview a merge, or tila schema diff and apply with --expected-revision.`,
            );
          // Older servers cannot return structured warnings yet.
          if (expected === undefined && !result.warnings?.length)
            warning(
              "schema apply sends the local files as the complete definition and replaces what the server has, without a revision check. Use tila schema import to preview a merge and apply it against the revision you reviewed.",
            );
        }

        if (args.json) {
          if (!result.ok)
            printJsonError(
              result.reason ?? "Schema apply failed",
              "schema-apply-failed",
              result.hint,
            );
          printJson({
            ok: result.ok,
            version: result.version,
            changes: result.changes,
            noChange: result.noChange ?? false,
            revision: result.revision,
            warnings: result.warnings ?? [],
          });
          return;
        }

        if (result.noChange) {
          outputText("No changes.");
          return;
        }

        if (!result.ok) {
          diagnostic(`Schema apply failed: ${result.reason ?? "unknown"}`);
          if (result.hint) diagnostic(`Hint: ${result.hint}`);
          exit(1);
        }

        outputText(`Applied schema version ${result.version}`);
        if (result.changes.length > 0) {
          for (const c of result.changes) outputText(`  - ${c}`);
        }
      },
    }),
    status: defineCommand({
      meta: {
        name: "status",
        description:
          "Compare local *.schema.toml files with the definitions applied on the server",
      },
      args: {
        ...jsonArg,
      },
      async run({ args }) {
        const { schema } = await resolveContext();
        const current = currentDefinition(await schema.getCurrentSchema());

        // status is read-only and never hard-errors: a missing or invalid
        // local file is reported as "unknown".
        const loaded = loadComposedSchema();
        const local = loaded.ok
          ? parseDefinitionDocument(loaded.definition)
          : null;
        const declaredVersion = loaded.ok ? loaded.schemaVersion : null;

        let status: "up-to-date" | "differs" | "unknown" = "unknown";
        let differences: {
          local_only: string[];
          server_only: string[];
          different: string[];
        } | null = null;
        if (local?.ok) {
          const compared = compareDefinitionUnits(current.doc ?? {}, local.doc);
          differences = {
            local_only: compared.added,
            server_only: compared.removed,
            different: compared.changed,
          };
          status =
            compared.added.length +
              compared.removed.length +
              compared.changed.length ===
            0
              ? "up-to-date"
              : "differs";
        }

        if (args.json) {
          printJson({
            applied_version: current.source === null ? null : current.revision,
            applied_revision: current.revision,
            declared_version: declaredVersion,
            status,
            differences,
          });
          return;
        }

        outputText(
          `Server revision:  ${current.source === null ? "(none applied)" : current.revision} (the server is authoritative)`,
        );
        outputText(
          `Local files:      ${loaded.ok ? `*.schema.toml (schema_version ${declaredVersion ?? "?"})` : loaded.code === "FILE_NOT_FOUND" ? "(none)" : "(invalid)"}`,
        );
        if (status === "up-to-date") {
          outputText("Status: local files match the server");
          return;
        }
        if (status === "unknown" || !differences) return;
        outputText("Status: local files differ from the server");
        list("Only in local files", differences.local_only);
        list("Only on the server", differences.server_only);
        list("Different", differences.different);
        outputText("");
        outputText("Preview importing the local files:  tila schema import");
        if (current.source !== null)
          outputText(
            "Replace them with the server's:      tila schema export --output tila.schema.toml --force",
          );
      },
    }),
    export: defineCommand({
      meta: {
        name: "export",
        description:
          "Export the applied definitions as TOML or YAML (definitions only, not a backup)",
      },
      args: {
        format: {
          type: "string",
          description: "toml or yaml (default: from --output, else toml)",
        },
        output: {
          type: "string",
          alias: "o",
          description: "Write to this file instead of stdout",
        },
        force: {
          type: "boolean",
          default: false,
          description: "Overwrite --output if it exists",
        },
        ...jsonArg,
      },
      async run({ args }) {
        let format = formatArg(args.format);
        if (!format && args.output) {
          const named = definitionFormatFromName(args.output);
          if (typeof named !== "string")
            throw cliError(named.code, named.message);
          format = named;
        }
        format ??= "toml";
        if (args.output && existsSync(args.output) && !args.force)
          throw cliError(
            "already-exists",
            `${args.output} already exists`,
            "Pass --force to overwrite it.",
          );

        const ctx = await resolveContext();
        const current = currentDefinition(await ctx.schema.getCurrentSchema());
        if (current.source === null)
          throw cliError(
            "not-found",
            "No definitions have been applied to this project yet",
            "Import a file first: tila schema import <file>",
          );
        const rendered = renderDefinitionExport(
          {
            source: current.source,
            projectId: ctx.config.project_id,
            revision: current.revision,
            appliedAt: current.appliedAt,
            exportedWith: `tila-cli ${CLI_VERSION}`,
          },
          format,
        );
        if (!rendered.ok)
          throw cliError(
            "export-failed",
            `The applied definition can't be exported:\n${formatDefinitionErrors(rendered.errors)}`,
          );

        if (args.output) writeFileSync(args.output, rendered.text, "utf8");
        if (args.json) {
          printJson({
            revision: current.revision,
            format,
            output: args.output ?? null,
            verbatim_paths: rendered.verbatimPaths,
            ...(args.output ? {} : { text: rendered.text }),
          });
          return;
        }
        if (!args.output) {
          rawOutput(rendered.text);
          return;
        }
        outputText(
          `Exported revision ${current.revision} to ${args.output} (${format.toUpperCase()}).`,
        );
        outputText(
          "Definitions only; comments are not kept. Use tila project export for a full backup.",
        );
      },
    }),
    import: defineCommand({
      meta: {
        name: "import",
        description:
          "Preview, then apply, a definitions file against the server revision (merge by default)",
      },
      args: {
        file: {
          type: "positional",
          required: false,
          description:
            ".toml, .yaml or .yml file (default: *.schema.toml in the current directory)",
        },
        format: {
          type: "string",
          description: "toml or yaml (default: from the file name)",
        },
        mode: {
          type: "string",
          default: "merge",
          description:
            "merge: replace the declarations in the file and keep the rest; replace: the file becomes the whole definition",
        },
        "expected-revision": {
          type: "string",
          description:
            "Apply against this revision (from the preview; 0 before the first apply). Without it, only preview.",
        },
        "confirm-removals": {
          type: "boolean",
          default: false,
          description: "Confirm the removals a replace import lists",
        },
        strategy: {
          type: "string",
          description:
            "Apply destructive changes the preview lists (relax|force)",
        },
        "idempotency-key": {
          type: "string",
          description: "Stable key when retrying this apply",
        },
        ...jsonArg,
      },
      async run({ args }) {
        const mode = (args.mode ?? "merge") as DefinitionImportMode;
        if (!MODES.includes(mode))
          throw cliError("invalid-argument", "--mode must be merge or replace");
        if (
          args.strategy !== undefined &&
          args.strategy !== "relax" &&
          args.strategy !== "force"
        )
          throw cliError(
            "invalid-argument",
            "--strategy must be relax or force",
          );
        const expected = definitionRevisionFlag(args["expected-revision"]);
        const source = importSource(args.file);
        const format = formatArg(args.format) ?? source.format;
        const file = readDefinitionFile(source.text, {
          format: format ?? "auto",
          filename: format ? undefined : source.filename,
        });
        if (!file.ok)
          throw cliError(
            file.errors[0]?.code ?? "definition-invalid",
            `${source.label} can't be imported:\n${formatDefinitionErrors(file.errors)}`,
          );

        const ctx = await resolveContext();
        const current = currentDefinition(await ctx.schema.getCurrentSchema());
        if (expected !== undefined && expected !== current.revision)
          throw cliError(
            "schema-revision-conflict",
            `The project is at revision ${current.revision}, not ${expected}`,
            `Preview again with ${["tila schema import", args.file].filter(Boolean).join(" ")} and review the changes.`,
          );

        const plan = planDefinitionImport(current.doc, file.doc, mode, {
          currentSource: current.source ?? undefined,
          metadata: file.metadata,
          projectId: ctx.config.project_id,
          revision: current.revision,
        });
        if (!plan.ok)
          throw cliError(
            plan.errors[0]?.code ?? "definition-invalid",
            `${source.label} can't be imported:\n${formatDefinitionErrors(plan.errors)}`,
          );

        const summary = {
          file: args.file ?? null,
          format: file.format,
          mode,
          revision: current.revision,
          units: plan.units,
          warnings: plan.warnings,
        };
        if (plan.noChange) {
          if (args.json) printJson({ status: "no-change", ...summary });
          else
            outputText(
              `No changes: ${source.label} matches revision ${current.revision}.`,
            );
          return;
        }

        const preview = await ctx.schema.previewSchema(plan.source);
        if (preview.revision !== current.revision)
          throw cliError(
            "schema-revision-conflict",
            `The definitions changed while previewing (now revision ${preview.revision})`,
            "Run the import again to review the latest revision.",
          );
        const destructive = !preview.autoApplicable;

        if (!args.json) {
          outputText(
            `Import ${basename(source.label)} (${file.format.toUpperCase()}, ${mode}) onto revision ${current.revision}`,
          );
          for (const note of plan.warnings) warning(note);
          list("Added", plan.units.added);
          list("Changed", plan.units.changed);
          list("Removed", plan.units.removed);
          if (plan.units.preserved.length > 0)
            outputText(
              `Kept as they are: ${plan.units.preserved.length} declarations the file doesn't mention`,
            );
          if (preview.changes.length > 0) {
            outputText("Effect on the server:");
            for (const change of preview.changes)
              outputText(describeSchemaChange(change));
          }
          if (destructive)
            outputText(
              "Destructive: yes. Stored tasks, records and artifacts are not deleted, but may no longer match the definition.",
            );
        }

        if (expected === undefined) {
          const next = [
            "tila schema import",
            args.file,
            mode === "replace" ? "--mode replace" : undefined,
            `--expected-revision ${current.revision}`,
            plan.units.removed.length > 0 ? "--confirm-removals" : undefined,
            destructive ? "--strategy relax" : undefined,
          ]
            .filter(Boolean)
            .join(" ");
          if (args.json) {
            printJson({
              status: "preview",
              ...summary,
              changes: preview.changes,
              autoApplicable: preview.autoApplicable,
              next,
            });
            return;
          }
          outputText("");
          outputText(`Nothing applied. To apply: ${next}`);
          return;
        }

        if (plan.units.removed.length > 0 && !args["confirm-removals"])
          throw cliError(
            "removals-not-confirmed",
            `A replace import removes ${plan.units.removed.length} declarations: ${plan.units.removed.join(", ")}`,
            "Review them, then re-run with --confirm-removals.",
          );
        if (destructive && !args.strategy)
          throw cliError(
            "schema-destructive",
            "The import makes destructive changes listed in the preview",
            "Re-run with --strategy relax to apply them.",
          );

        const result = await ctx.schema.applySchema({
          definition: plan.source,
          expected_revision: current.revision,
          reviewed_definition: preview.reviewed_definition,
          ...(args.strategy ? { strategy: args.strategy } : {}),
          ...(args["idempotency-key"]
            ? { idempotency_key: args["idempotency-key"] }
            : {}),
        });
        if (!result.ok)
          throw cliError(
            result.reason === "destructive"
              ? "schema-destructive"
              : "schema-apply-failed",
            `Import not applied: ${result.reason ?? "unknown reason"}`,
            result.hint,
          );
        const revision = result.revision ?? result.version ?? current.revision;
        if (args.json) {
          printJson({
            status: result.noChange ? "no-change" : "applied",
            ...summary,
            revision,
            changes: result.changes,
          });
          return;
        }
        outputText("");
        outputText(
          result.noChange
            ? "No revision recorded: only comments or keys tila doesn't use differ."
            : `Applied as revision ${revision}.`,
        );
      },
    }),
  },
});
