import { readFileSync } from "node:fs";
import { defineCommand } from "citty";
import { TilaApiError } from "tila-sdk";
import { z } from "zod";
import { resolveContext } from "../context";
import { printJson, printJsonError } from "../lib/output";

const PreviewSchemaResponseSchema = z.object({
  ok: z.literal(true),
  changes: z.array(z.record(z.unknown())),
  autoApplicable: z.boolean(),
});

export default defineCommand({
  meta: { name: "schema", description: "Manage project schema" },
  subCommands: {
    diff: defineCommand({
      meta: {
        name: "diff",
        description: "Preview schema changes without applying",
      },
      args: {
        json: {
          type: "boolean",
          description: "Output as JSON",
          default: false,
        },
      },
      async run({ args }) {
        const ctx = await resolveContext();

        if (!ctx.client) {
          console.error("Error: tila schema diff requires a remote backend.");
          process.exit(1);
        }

        // Read tila.schema.toml from current working directory
        let definition: string;
        try {
          definition = readFileSync("tila.schema.toml", "utf8");
        } catch {
          if (args.json) {
            printJsonError(
              "tila.schema.toml not found in current directory",
              "FILE_NOT_FOUND",
            );
          } else {
            console.error(
              "Error: tila.schema.toml not found in current directory.",
            );
          }
          process.exit(1);
        }

        let result: z.infer<typeof PreviewSchemaResponseSchema>;
        try {
          result = await ctx.client.post(
            `/projects/${ctx.config.project_id}/schema/preview`,
            { definition },
            { schema: PreviewSchemaResponseSchema, validate: true },
          );
        } catch (err) {
          if (err instanceof TilaApiError && err.status === 400) {
            if (args.json) {
              printJsonError(err.message, "SCHEMA_PARSE_ERROR");
            } else {
              console.error(`Schema parse error: ${err.message}`);
            }
            process.exit(1);
          }
          throw err;
        }

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
        for (const change of result.changes) {
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
        json: {
          type: "boolean",
          description: "Output as JSON",
          default: false,
        },
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
        json: {
          type: "boolean",
          description: "Output as JSON",
          default: false,
        },
      },
      async run({ args }) {
        const { schema } = await resolveContext();

        // Read tila.schema.toml from current working directory
        let definition: string;
        try {
          definition = readFileSync("tila.schema.toml", "utf8");
        } catch {
          if (args.json) {
            printJsonError(
              "tila.schema.toml not found in current directory",
              "FILE_NOT_FOUND",
            );
          }
          console.error(
            "Error: tila.schema.toml not found in current directory.",
          );
          process.exit(1);
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
        json: {
          type: "boolean",
          description: "Output as JSON",
          default: false,
        },
      },
      async run({ args }) {
        const { schema } = await resolveContext();
        const record = await schema.getCurrentSchema();

        let declaredVersion: number | null = null;
        try {
          const toml = readFileSync("tila.schema.toml", "utf8");
          const match = /^\s*schema_version\s*=\s*(\d+)/m.exec(toml);
          if (match) declaredVersion = Number.parseInt(match[1], 10);
        } catch {
          // No local tila.schema.toml — that's fine for status
        }

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
