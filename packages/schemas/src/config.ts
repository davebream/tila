import { z } from "zod";

// --- tila.config.toml (parsed) ---

export const TilaProjectConfigSchema = z.object({
  project_id: z.string(),
  backend: z.enum(["cloudflare", "local"]).optional(),
  worker_url: z.string().url().optional(),
  custom_domain: z.string().optional(),
  schema_version: z.number().int(),
  tila_version: z.string(),
  created_at: z.string(), // ISO-8601 string from TOML
  cloudflare: z
    .object({
      account_id: z.string(),
    })
    .optional(),
  backends: z
    .object({
      entity: z.string().default("do-sqlite"),
      coordination: z.string().default("do-sqlite"),
      artifact: z.string().default("r2"),
      auth: z.string().default("d1"),
    })
    .optional(),
  local: z
    .object({
      db_path: z.string(),
      artifacts_path: z.string(),
      org: z.string().optional(),
    })
    .optional(),
  auth: z
    .object({
      mode: z.enum(["tila-token", "github-repo"]).default("tila-token"),
    })
    .optional(),
  github: z
    .object({
      host: z.string().default("github.com"),
      owner: z.string(),
      repo: z.string(),
      repo_id: z.number().int().optional(),
    })
    .optional(),
});

export type TilaProjectConfig = z.infer<typeof TilaProjectConfigSchema>;

// --- tila.schema.toml (parsed, structural) ---
// Full spec-aligned schema covering all four sections from docs/02-ARCHITECTURE.md §6.1.
// The TOML spec declares fields as an array of objects; the canonical TypeScript type
// uses Record<string, FieldDeclaration>. A Zod preprocessor converts array→record at parse time.

function arrayToRecord(val: unknown): unknown {
  if (!Array.isArray(val)) return val;
  const entries = (val as Array<{ name: string; [k: string]: unknown }>).map(
    (f) => [f.name, f] as const,
  );
  return Object.fromEntries(entries);
}

const FieldDeclarationSchema = z.object({
  type: z.string(),
  required: z.boolean().default(false),
  default: z.unknown().optional(),
  default_for_legacy: z.unknown().optional(),
  name: z.string().optional(),
  values: z.array(z.string()).optional(),
});

export type FieldDeclaration = z.infer<typeof FieldDeclarationSchema>;

const ReferenceSlotSchema = z.object({
  name: z.string(),
  multiple: z.boolean().default(false),
  kinds: z.array(z.string()),
});

export type ReferenceSlot = z.infer<typeof ReferenceSlotSchema>;

const WorkUnitSchema = z.object({
  fields: z
    .preprocess(arrayToRecord, z.record(FieldDeclarationSchema))
    .default({}),
  parents: z.array(z.string()).default([]),
  required_parent: z.boolean().default(false),
  references: z.array(ReferenceSlotSchema).optional(),
});

export type WorkUnit = z.infer<typeof WorkUnitSchema>;

const ArtifactKindSchema = z.object({
  mime_types: z.array(z.string().min(1)).default([]),
  retention_days: z.number().int().min(0).default(0),
  requires_reference_to: z.array(z.string()).optional(),
  searchable: z.boolean().default(false),
  search_mode: z.enum(["none", "full_text"]).default("none"),
  auto_supersedes: z.boolean().default(false),
});

export type ArtifactKind = z.infer<typeof ArtifactKindSchema>;

const TemplateEntitySchema = z.object({
  id_suffix: z.string().default(""),
  type: z.string(),
  data: z.record(z.unknown()).default({}),
});

export type TemplateEntity = z.infer<typeof TemplateEntitySchema>;

const TemplateRelationshipSchema = z.object({
  from: z.string(),
  to: z.string(),
  type: z.string(),
});

export type TemplateRelationship = z.infer<typeof TemplateRelationshipSchema>;

const TemplateDefinitionSchema = z.object({
  description: z.string().optional(),
  entities: z.record(TemplateEntitySchema),
  relationships: z.array(TemplateRelationshipSchema).default([]),
});

export type TemplateDefinition = z.infer<typeof TemplateDefinitionSchema>;

const RecordDefinitionFieldsSchema = z
  .preprocess(arrayToRecord, z.record(FieldDeclarationSchema))
  .default({});

export const RecordDefinitionSchema = z.object({
  format: z.enum(["json", "yaml"]).default("json"),
  history: z.enum(["revision", "snapshot"]).default("revision"),
  key_description: z.string().optional(),
  writers: z.array(z.enum(["human", "agent"])).optional(),
  mcp_resource: z.boolean().default(false),
  schema_ref: z.string().optional(),
  fields: RecordDefinitionFieldsSchema,
});

export type RecordDefinition = z.infer<typeof RecordDefinitionSchema>;

export const TilaSchemaTomlSchema = z.object({
  schema_version: z.number().int().positive(),
  work_units: z.record(WorkUnitSchema).default({}),
  hierarchy: z
    .object({
      levels: z.array(z.string()).default([]),
      max_depth: z.number().int().positive().optional(),
    })
    .optional(),
  artifacts: z.record(ArtifactKindSchema).optional(),
  artifact_relationships: z
    .object({
      types: z.array(z.string()).optional(),
    })
    .optional(),
  entity_artifact_references: z
    .object({
      slots: z.array(z.string()).optional(),
    })
    .optional(),
  templates: z.record(TemplateDefinitionSchema).optional(),
  records: z.record(RecordDefinitionSchema).default({}),
});

export type TilaSchemaToml = z.infer<typeof TilaSchemaTomlSchema>;

// --- Fragment composition merge policy ---
// Single source of truth for how each top-level section is merged when multiple
// *.schema.toml fragments are composed into one effective definition.
export const SCHEMA_SECTION_MERGE_POLICY = {
  work_units: "disjoint-keys",
  records: "disjoint-keys",
  templates: "disjoint-keys",
  artifacts: "disjoint-keys",
  hierarchy: "singleton",
  artifact_relationships: "singleton",
  entity_artifact_references: "singleton",
  schema_version: "singleton-scalar",
} as const;
export type SchemaSectionMergePolicy = typeof SCHEMA_SECTION_MERGE_POLICY;
