import type { SchemaBackend } from "@tila/core";
import {
  InstantiateTemplateResponseSchema,
  type TilaSchemaToml,
  TilaSchemaTomlSchema,
} from "@tila/schemas";
import { defineCommand } from "citty";
import { parse as parseTOML } from "smol-toml";
import { requireClient, resolveContext } from "../context";
import { printJson, printJsonError } from "../lib/output";

/** Fetch and parse the current schema TOML from the backend. */
async function fetchSchemaToml(
  schemaBackend: SchemaBackend,
): Promise<TilaSchemaToml | null> {
  try {
    const record = await schemaBackend.getCurrentSchema();
    if (!record.definition) return null;
    // definition may be TOML (local) or JSON string (remote)
    let raw: unknown;
    try {
      raw = JSON.parse(record.definition);
    } catch {
      raw = parseTOML(record.definition);
    }
    return TilaSchemaTomlSchema.parse(raw);
  } catch {
    return null;
  }
}

export default defineCommand({
  meta: { name: "template", description: "Manage entity templates" },
  subCommands: {
    list: defineCommand({
      meta: { name: "list", description: "List available templates" },
      args: {
        json: {
          type: "boolean",
          description: "Output as JSON",
          default: false,
        },
      },
      async run({ args }) {
        const ctx = await resolveContext();
        const schema = await fetchSchemaToml(ctx.schema);
        if (!schema) {
          if (args.json) {
            printJsonError("No schema applied or failed to fetch", "NO_SCHEMA");
          }
          console.error(
            "No schema applied to this project or failed to fetch.",
          );
          process.exit(1);
        }
        const templateMap = schema.templates ?? {};
        const entries = Object.entries(templateMap).map(([name, def]) => ({
          name,
          description: def.description ?? null,
          entity_count: Object.keys(def.entities).length,
        }));
        if (args.json) {
          printJson({ templates: entries });
          return;
        }
        if (entries.length === 0) {
          console.log("No templates defined in schema.");
          return;
        }
        for (const t of entries) {
          const desc = t.description ? ` -- ${t.description}` : "";
          console.log(`  ${t.name} (${t.entity_count} entities)${desc}`);
        }
      },
    }),
    show: defineCommand({
      meta: { name: "show", description: "Show template details" },
      args: {
        name: {
          type: "positional",
          description: "Template name",
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
        const schema = await fetchSchemaToml(ctx.schema);
        if (!schema) {
          if (args.json) {
            printJsonError("No schema applied or failed to fetch", "NO_SCHEMA");
          }
          console.error(
            "No schema applied to this project or failed to fetch.",
          );
          process.exit(1);
        }
        const templateMap = schema.templates ?? {};
        const name = args.name as string;
        const templateDef = templateMap[name];
        if (!templateDef) {
          if (args.json) {
            printJsonError(`Template "${name}" not found`, "NOT_FOUND");
          }
          console.error(`Template "${name}" not found in schema.`);
          process.exit(1);
        }
        if (args.json) {
          printJson({ name, template: templateDef });
          return;
        }
        console.log(`Template: ${name}`);
        if (templateDef.description) {
          console.log(`Description: ${templateDef.description}`);
        }
        console.log("\nEntities:");
        for (const [key, ent] of Object.entries(templateDef.entities)) {
          const suffix = ent.id_suffix
            ? ` (suffix: "${ent.id_suffix}")`
            : " (root)";
          console.log(`  ${key}: type=${ent.type}${suffix}`);
          if (Object.keys(ent.data).length > 0) {
            console.log(`    data: ${JSON.stringify(ent.data)}`);
          }
        }
        if (templateDef.relationships.length > 0) {
          console.log("\nRelationships:");
          for (const rel of templateDef.relationships) {
            console.log(`  ${rel.from} --[${rel.type}]--> ${rel.to}`);
          }
        }
      },
    }),
    instantiate: defineCommand({
      meta: {
        name: "instantiate",
        description: "Instantiate a template to create entities",
      },
      args: {
        name: {
          type: "positional",
          description: "Template name",
          required: true,
        },
        id: {
          type: "string",
          description: "Root entity ID",
          required: true,
        },
        var: {
          type: "string",
          description: "Variable substitution in key=value format (repeatable)",
        },
        json: {
          type: "boolean",
          description: "Output as JSON",
          default: false,
        },
      },
      async run({ args }) {
        const ctx = await resolveContext();

        // Parse --var: may be a single string or array (Citty repeatable flag)
        const vars: Record<string, string> = {};
        const rawVar = args.var;
        if (rawVar) {
          const varEntries = Array.isArray(rawVar) ? rawVar : [rawVar];
          for (const entry of varEntries as string[]) {
            const eqIdx = entry.indexOf("=");
            if (eqIdx === -1) {
              if (args.json) {
                printJsonError(
                  `Invalid --var format: "${entry}". Expected key=value`,
                  "INVALID_VAR",
                );
              }
              console.error(
                `Invalid --var format: "${entry}". Expected key=value`,
              );
              process.exit(1);
            }
            const key = entry.slice(0, eqIdx);
            const value = entry.slice(eqIdx + 1);
            vars[key] = value;
          }
        }

        // TODO T8: template instantiate requires entity creation -- remote-only for now
        const result = await requireClient(ctx).post(
          `/projects/${ctx.config.project_id}/templates/instantiate`,
          {
            template_name: args.name as string,
            root_id: args.id as string,
            vars,
          },
          { schema: InstantiateTemplateResponseSchema, validate: true },
        );

        if (args.json) {
          printJson(result);
          return;
        }

        console.log(
          `Instantiated template "${args.name}" -- created ${result.created_entities.length} entities, ${result.created_relationships} relationships`,
        );
        console.log(`Entities: ${result.created_entities.join(", ")}`);
        console.log(`Journal seq: ${result.journal_seq}`);
      },
    }),
  },
});
