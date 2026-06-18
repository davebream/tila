import { diffSchemas, parseSchemaToml } from "@tila/core";
import { type TilaSchemaToml, TilaSchemaTomlSchema } from "@tila/schemas";
import { defineCommand } from "citty";
import { parse as parseTOML } from "smol-toml";
import { resolveContext } from "../context";
import { jsonArg, printJson, printJsonError } from "../lib/output";
import { loadComposedSchema } from "../lib/schema-loader";

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
    return TilaSchemaTomlSchema.parse({ schema_version: 0, work_units: {} });
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
              console.error(
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
              console.error(`Schema parse error: ${msgs}`);
            }
          }
          process.exit(1);
          return; // unreachable at runtime; needed so mocked exit in tests doesn't fall through
        }

        const { definition } = loaded;

        // Render advisory warnings as a single block (not N bullets)
        if (loaded.warnings.length > 0) {
          const warningLines = loaded.warnings
            .map((w) => `  ${w.message} (${w.fragments.join(", ")})`)
            .join("\n");
          console.warn(`Schema composition warnings:\n${warningLines}`);
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
            console.error(`Schema parse error: ${msgs}`);
          }
          process.exit(1);
          return;
        }

        // Diff the proposed schema against the current applied schema.
        const current = await ctx.schema.getCurrentSchema();
        const previous = parseCurrentDefinition(current.definition);
        const result = diffSchemas(previous, proposed.schema);

        if (args.json) {
          printJson({
            changes: result.changes,
            autoApplicable: result.autoApplicable,
          });
          return;
        }

        if (result.changes.length === 0) {
          console.log("No changes detected.");
          return;
        }

        console.log("Changes:");
        for (const rawChange of result.changes) {
          // `diffSchemas` returns a discriminated union; the renderer reads
          // fields across variants (and the optional `entityCount`/`recordCount`
          // present only in the DB-enriched remote variant, which is 0 here).
          // A permissive record view keeps the human-readable output byte-for-byte
          // identical to the old remote rendering.
          const change = rawChange as Record<string, unknown>;
          const kind = change.kind as string;
          switch (kind) {
            case "work-unit-added":
              console.log(`  + Added work-unit type: ${change.unitType}`);
              break;
            case "work-unit-removed": {
              const count = change.entityCount as number;
              const suffix =
                count > 0
                  ? ` (${count} active ${count === 1 ? "entity" : "entities"} would be orphaned)`
                  : "";
              console.log(
                `  - Removed work-unit type: ${change.unitType}${suffix}`,
              );
              break;
            }
            case "field-added":
              console.log(
                `  + Added field '${change.fieldName}' to ${change.unitType} (optional)`,
              );
              break;
            case "field-removed": {
              const count = change.entityCount as number;
              const suffix =
                count > 0
                  ? ` (${count} active ${count === 1 ? "entity" : "entities"} affected)`
                  : "";
              console.log(
                `  - Removed field '${change.fieldName}' from ${change.unitType}${suffix}`,
              );
              break;
            }
            case "field-required-added":
              console.log(
                `  + Added required field '${change.fieldName}' to ${change.unitType}`,
              );
              break;
            case "artifact-kind-added":
              console.log(`  + Added artifact kind: ${change.artifactKind}`);
              break;
            case "artifact-kind-removed":
              console.log(`  - Removed artifact kind: ${change.artifactKind}`);
              break;
            case "record-type-added":
              console.log(`  + Added record type: ${change.typeName}`);
              break;
            case "record-type-removed": {
              const count = change.recordCount as number;
              const suffix =
                count > 0
                  ? ` (${count} active ${count === 1 ? "record" : "records"} would be orphaned)`
                  : "";
              console.log(
                `  - Removed record type: ${change.typeName}${suffix}`,
              );
              break;
            }
            case "record-field-added":
              console.log(
                `  + Added field '${change.fieldName}' to record type ${change.typeName}`,
              );
              break;
            case "record-field-removed":
              console.log(
                `  - Removed field '${change.fieldName}' from record type ${change.typeName}`,
              );
              break;
            case "record-field-required-added":
              console.log(
                `  + Added required field '${change.fieldName}' to record type ${change.typeName}`,
              );
              break;
            default:
              console.log(`  ~ ${kind}`);
          }
        }

        console.log("");
        console.log(`Auto-applicable: ${result.autoApplicable ? "Yes" : "No"}`);
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
        console.log(`Schema version: ${record.version ?? "(none)"}`);
        if (record.definition) {
          try {
            console.log(JSON.stringify(JSON.parse(record.definition), null, 2));
          } catch {
            console.log(record.definition);
          }
        }
      },
    }),
    apply: defineCommand({
      meta: { name: "apply", description: "Apply schema changes" },
      args: {
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
              console.error(
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
              console.error(`Schema parse error: ${msgs}`);
            }
          }
          process.exit(1);
          return; // TypeScript: unreachable, but helps narrowing
        }

        const { definition } = loaded;

        // Render advisory warnings as a single block (not N bullets — per cli-output.md)
        if (loaded.warnings.length > 0) {
          const warningLines = loaded.warnings
            .map((w) => `  ${w.message} (${w.fragments.join(", ")})`)
            .join("\n");
          console.warn(`Schema composition warnings:\n${warningLines}`);
        }

        const result = await schema.applySchema({
          definition,
          strategy: args.strategy as string | undefined,
        });

        if (args.json) {
          printJson({
            ok: result.ok,
            version: result.version,
            changes: result.changes,
            noChange: result.noChange ?? false,
          });
          return;
        }

        if (result.noChange) {
          console.log("No changes.");
          return;
        }

        if (!result.ok) {
          console.error(`Schema apply failed: ${result.reason ?? "unknown"}`);
          if (result.hint) console.error(`Hint: ${result.hint}`);
          process.exit(1);
        }

        console.log(`Applied schema version ${result.version}`);
        if (result.changes.length > 0) {
          for (const c of result.changes) console.log(`  - ${c}`);
        }
      },
    }),
    status: defineCommand({
      meta: { name: "status", description: "Show schema status" },
      args: {
        ...jsonArg,
      },
      async run({ args }) {
        const { schema } = await resolveContext();
        const record = await schema.getCurrentSchema();

        // Read declared version via loadComposedSchema (no regex on serialized output).
        // status is read-only and must never hard-error:
        //   - FILE_NOT_FOUND → no local schema file is fine (declaredVersion stays null)
        //   - SCHEMA_PARSE_ERROR → swallow and report declared version as unknown
        //     (preserves the old regex leniency for status)
        let declaredVersion: number | null = null;
        const loaded = loadComposedSchema();
        if (loaded.ok) {
          declaredVersion = loaded.schemaVersion;
        }
        // FILE_NOT_FOUND and SCHEMA_PARSE_ERROR both leave declaredVersion as null

        const appliedVersion = record.version ?? null;

        if (args.json) {
          let status: string;
          if (appliedVersion !== null && declaredVersion !== null) {
            if (appliedVersion === declaredVersion) status = "up-to-date";
            else if (declaredVersion > appliedVersion) status = "pending-apply";
            else status = "ahead";
          } else {
            status = "unknown";
          }
          printJson({
            applied_version: appliedVersion,
            declared_version: declaredVersion,
            status,
          });
          return;
        }

        console.log(`Applied version:  ${appliedVersion ?? "(none)"}`);
        console.log(`Declared version: ${declaredVersion ?? "(unknown)"}`);

        if (appliedVersion !== null && declaredVersion !== null) {
          if (appliedVersion === declaredVersion) {
            console.log("Status: up to date");
          } else if (declaredVersion > appliedVersion) {
            console.log("Status: pending apply");
          } else {
            console.log("Status: applied version ahead of local file");
          }
        }
      },
    }),
  },
});
