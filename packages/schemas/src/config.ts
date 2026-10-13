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
  instance: z
    .object({
      instance_key: z.string().optional(),
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

export const FieldDeclarationSchema = z.object({
  type: z.string(),
  required: z.boolean().default(false),
  default: z.unknown().optional(),
  default_for_legacy: z.unknown().optional(),
  name: z.string().optional(),
  values: z.array(z.string()).optional(),
});

export type FieldDeclaration = z.infer<typeof FieldDeclarationSchema>;

// Presentation metadata is display-only: it names which declared fields a
// client should show as the title, summary, or description. It never changes
// validation, storage, or coordination semantics.
export const WorkPresentationSchema = z.object({
  title: z.string().min(1).optional(),
  summary: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
});
export type WorkPresentation = z.infer<typeof WorkPresentationSchema>;

export const RecordPresentationSchema = z.object({
  title: z.string().min(1).optional(),
  summary: z.string().min(1).optional(),
  // Business classification declared by the definition. Unset means the
  // definition makes no claim; clients must not infer it from the type name.
  kind: z.enum(["configuration", "content"]).optional(),
});
export type RecordPresentation = z.infer<typeof RecordPresentationSchema>;

const PRESENTABLE_FIELD_TYPES = new Set(["string", "text", "enum"]);

function checkPresentationFields(
  presentation: Record<string, unknown> | undefined,
  slots: readonly string[],
  fields: Record<string, FieldDeclaration>,
  ctx: z.RefinementCtx,
): void {
  if (!presentation) return;
  for (const slot of slots) {
    const name = presentation[slot];
    if (typeof name !== "string") continue;
    const field = fields[name];
    if (!field || !PRESENTABLE_FIELD_TYPES.has(field.type)) {
      ctx.addIssue({
        code: "custom",
        path: ["presentation", slot],
        message: `presentation.${slot} must reference a declared string, text, or enum field`,
      });
    }
  }
}

const ReferenceSlotSchema = z.object({
  require_trusted_for_statuses: z.array(z.string().min(1)).optional(),
  name: z.string(),
  multiple: z.boolean().default(false),
  kinds: z.array(z.string()),
});

export type ReferenceSlot = z.infer<typeof ReferenceSlotSchema>;

/** Terminal outcomes a work type's lifecycle can name a state for. */
export const LIFECYCLE_OUTCOMES = [
  "success",
  "failure",
  "cancelled",
  "abandoned",
] as const;
export const LifecycleOutcomeSchema = z.enum(LIFECYCLE_OUTCOMES);
export type LifecycleOutcome = z.infer<typeof LifecycleOutcomeSchema>;

export const WorkLifecycleSchema = z.object({
  field: z.string().min(1),
  dispatchable: z.array(z.string().min(1)).min(1),
  terminal: z.array(z.string().min(1)).min(1),
  dependency_satisfied: z.array(z.string().min(1)).min(1),
  on_start: z.string().min(1).optional(),
  outcomes: z
    .object({
      success: z.string().min(1).optional(),
      failure: z.string().min(1).optional(),
      cancelled: z.string().min(1).optional(),
      abandoned: z.string().min(1).optional(),
    })
    .optional(),
});
export type WorkLifecycle = z.infer<typeof WorkLifecycleSchema>;

const WorkUnitSchema = z
  .object({
    lifecycle: WorkLifecycleSchema.optional(),
    fields: z
      .preprocess(arrayToRecord, z.record(z.string(), FieldDeclarationSchema))
      .default({}),
    parents: z.array(z.string()).default([]),
    required_parent: z.boolean().default(false),
    references: z.array(ReferenceSlotSchema).optional(),
    presentation: WorkPresentationSchema.optional(),
  })
  .superRefine((unit, ctx) => {
    checkPresentationFields(
      unit.presentation,
      ["title", "summary", "description"],
      unit.fields,
      ctx,
    );
    const lifecycle = unit.lifecycle;
    if (!lifecycle) return;
    const issue = (message: string) =>
      ctx.addIssue({ code: "custom", path: ["lifecycle"], message });
    const field = unit.fields[lifecycle.field];
    if (!field || !["string", "text", "enum"].includes(field.type))
      issue("Lifecycle field must declare a string, text, or enum field");
    if (
      lifecycle.dispatchable.some((state) => lifecycle.terminal.includes(state))
    )
      issue("Dispatchable and terminal states must be disjoint");
    if (
      lifecycle.dependency_satisfied.some(
        (state) => !lifecycle.terminal.includes(state),
      )
    )
      issue("Dependency-satisfying states must be terminal");
    if (lifecycle.on_start && lifecycle.terminal.includes(lifecycle.on_start))
      issue("The start state cannot be terminal");
    const states = [
      ...lifecycle.dispatchable,
      ...lifecycle.terminal,
      ...lifecycle.dependency_satisfied,
      ...Object.values(lifecycle.outcomes ?? {}),
      ...(lifecycle.on_start ? [lifecycle.on_start] : []),
    ];
    if (field?.values && states.some((state) => !field.values?.includes(state)))
      issue("Lifecycle states must be allowed by the declared field values");
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
  data: z.record(z.string(), z.unknown()).default({}),
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
  entities: z.record(z.string(), TemplateEntitySchema),
  relationships: z.array(TemplateRelationshipSchema).default([]),
});

export type TemplateDefinition = z.infer<typeof TemplateDefinitionSchema>;

const RecordDefinitionFieldsSchema = z
  .preprocess(arrayToRecord, z.record(z.string(), FieldDeclarationSchema))
  .default({});

export const RecordDefinitionSchema = z
  .object({
    format: z.enum(["json", "yaml"]).default("json"),
    history: z.enum(["revision", "snapshot"]).default("revision"),
    key_description: z.string().optional(),
    writers: z.array(z.enum(["human", "agent"])).optional(),
    mcp_resource: z.boolean().default(false),
    schema_ref: z.string().optional(),
    fields: RecordDefinitionFieldsSchema,
    presentation: RecordPresentationSchema.optional(),
  })
  .superRefine((definition, ctx) => {
    // A definition validated by an external schema_ref has no local field
    // list to check presentation references against.
    if (definition.schema_ref && Object.keys(definition.fields).length === 0)
      return;
    checkPresentationFields(
      definition.presentation,
      ["title", "summary"],
      definition.fields,
      ctx,
    );
  });

export type RecordDefinition = z.infer<typeof RecordDefinitionSchema>;

export const TilaSchemaTomlSchema = z.object({
  schema_version: z.number().int().positive(),
  work_units: z.record(z.string(), WorkUnitSchema).default({}),
  hierarchy: z
    .object({
      levels: z.array(z.string()).default([]),
      max_depth: z.number().int().positive().optional(),
    })
    .optional(),
  artifacts: z.record(z.string(), ArtifactKindSchema).optional(),
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
  templates: z.record(z.string(), TemplateDefinitionSchema).optional(),
  records: z.record(z.string(), RecordDefinitionSchema).default({}),
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

// --- Definition import/export ---

/** Largest definition accepted for preview, apply and import, in UTF-8 bytes. */
export const DEFINITION_MAX_BYTES = 256 * 1024;

/**
 * Request body limit for schema writes: the definition, its reviewed copy and
 * the JSON envelope. The idempotency receipt keeps both texts in one DO row,
 * so the definition cap must stay well under the 2 MB row limit.
 */
export const DEFINITION_REQUEST_MAX_BYTES =
  4 * DEFINITION_MAX_BYTES + 64 * 1024;

/** Reserved top-level table carrying export metadata; never part of a definition. */
export const DEFINITION_EXPORT_KEY = "tila_export";
export const DEFINITION_EXPORT_FORMAT = "tila-definitions";
export const DEFINITION_EXPORT_FORMAT_VERSION = 1;

/**
 * Metadata written into `[tila_export]`. It records where the file came from;
 * it is not an authority, and import checks only `format` and `format_version`.
 */
export const DefinitionExportMetadataSchema = z.object({
  format: z.literal(DEFINITION_EXPORT_FORMAT),
  format_version: z.number().int().positive(),
  project_id: z.string().optional(),
  revision: z.number().int().nonnegative().optional(),
  exported_at: z.string().optional(),
  applied_at: z.string().optional(),
  exported_with: z.string().optional(),
});
export type DefinitionExportMetadata = z.infer<
  typeof DefinitionExportMetadataSchema
>;

/** UTF-8 length of `text`, without depending on TextEncoder typings. */
export function definitionByteLength(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (
      code >= 0xd800 &&
      code <= 0xdbff &&
      i + 1 < text.length &&
      (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00
    ) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}
