import {
  RecordTypeSchema,
  type TemplateEntity,
  type TilaSchemaToml,
  TilaSchemaTomlSchema,
} from "@tila/schemas";
import { parse as parseTOML } from "smol-toml";

// --- Public types ---

export type SchemaParseError = {
  message: string;
  path?: string;
  line?: number;
  column?: number;
};

export type ParseSchemaResult =
  | { ok: true; schema: TilaSchemaToml }
  | { ok: false; errors: SchemaParseError[] };

export class SchemaParseException extends Error {
  readonly errors: SchemaParseError[];

  constructor(errors: SchemaParseError[]) {
    const summary = errors.map((e) => e.message).join("; ");
    super(`Schema parse failed: ${summary}`);
    this.name = "SchemaParseException";
    this.errors = errors;
  }
}

// --- Internal helpers ---

function zodIssuesToParseErrors(
  issues: { message: string; path: (string | number)[] }[],
): SchemaParseError[] {
  return issues.map((issue) => ({
    message: issue.message,
    path: issue.path.join("."),
  }));
}

function checkUnknownParents(schema: TilaSchemaToml): SchemaParseError[] {
  const errors: SchemaParseError[] = [];
  const knownTypes = new Set(Object.keys(schema.work_units));

  for (const [typeName, unit] of Object.entries(schema.work_units)) {
    const parents = unit.parents ?? [];
    for (let i = 0; i < parents.length; i++) {
      if (!knownTypes.has(parents[i])) {
        errors.push({
          message: `references unknown type "${parents[i]}"`,
          path: `work_units.${typeName}.parents[${i}]`,
        });
      }
    }
  }

  return errors;
}

function checkHierarchyLevels(schema: TilaSchemaToml): SchemaParseError[] {
  const errors: SchemaParseError[] = [];
  if (!schema.hierarchy) return errors;

  const knownTypes = new Set(Object.keys(schema.work_units));
  const levels = schema.hierarchy.levels;

  for (let i = 0; i < levels.length; i++) {
    if (!knownTypes.has(levels[i])) {
      errors.push({
        message: `references undeclared work-unit type "${levels[i]}"`,
        path: `hierarchy.levels[${i}]`,
      });
    }
  }

  if (
    schema.hierarchy.max_depth !== undefined &&
    levels.length > schema.hierarchy.max_depth
  ) {
    errors.push({
      message: `levels count (${levels.length}) exceeds max_depth (${schema.hierarchy.max_depth})`,
      path: "hierarchy",
    });
  }

  return errors;
}

function checkCircularParents(schema: TilaSchemaToml): SchemaParseError[] {
  const errors: SchemaParseError[] = [];
  const knownTypes = Object.keys(schema.work_units);

  // Build adjacency: child -> parents
  const parentMap = new Map<string, string[]>();
  for (const [typeName, unit] of Object.entries(schema.work_units)) {
    parentMap.set(typeName, unit.parents ?? []);
  }

  // DFS cycle detection
  const visited = new Set<string>();
  const inStack = new Set<string>();

  function dfs(node: string, path: string[]): void {
    if (inStack.has(node)) {
      const cycleStart = path.indexOf(node);
      const cycle = [...path.slice(cycleStart), node];
      errors.push({
        message: `circular parent chain detected: ${cycle.join(" -> ")}`,
        path: "work_units",
      });
      return;
    }
    if (visited.has(node)) return;

    visited.add(node);
    inStack.add(node);

    const parents = parentMap.get(node) ?? [];
    for (const parent of parents) {
      if (parentMap.has(parent)) {
        dfs(parent, [...path, node]);
      }
    }

    inStack.delete(node);
  }

  for (const typeName of knownTypes) {
    if (!visited.has(typeName)) {
      dfs(typeName, []);
    }
  }

  return errors;
}

const VALID_FIELD_TYPES = new Set(["string", "text", "enum", "list<string>"]);

const VALID_RECORD_FIELD_TYPES = new Set([
  "string",
  "text",
  "enum",
  "list<string>",
  "number",
  "boolean",
  "json",
]);

function checkFieldTypes(schema: TilaSchemaToml): SchemaParseError[] {
  const errors: SchemaParseError[] = [];

  for (const [typeName, unit] of Object.entries(schema.work_units)) {
    for (const [fieldName, decl] of Object.entries(unit.fields)) {
      if (!VALID_FIELD_TYPES.has(decl.type)) {
        errors.push({
          message: `unknown type "${decl.type}"; valid: string, text, enum, list<string>`,
          path: `work_units.${typeName}.fields.${fieldName}.type`,
        });
      }
    }
  }

  return errors;
}

function checkTemplateEntityTypes(schema: TilaSchemaToml): SchemaParseError[] {
  const errors: SchemaParseError[] = [];
  if (!schema.templates) return errors;

  const knownTypes = new Set(Object.keys(schema.work_units));

  for (const [templateName, template] of Object.entries(schema.templates)) {
    for (const [entityKey, entity] of Object.entries(template.entities) as [
      string,
      TemplateEntity,
    ][]) {
      if (!knownTypes.has(entity.type)) {
        errors.push({
          message: `references unknown work-unit type "${entity.type}"`,
          path: `templates.${templateName}.entities.${entityKey}.type`,
        });
      }
    }
  }

  return errors;
}

function checkRecordTypeNames(schema: TilaSchemaToml): SchemaParseError[] {
  const errors: SchemaParseError[] = [];

  for (const typeName of Object.keys(schema.records ?? {})) {
    const result = RecordTypeSchema.safeParse(typeName);
    if (!result.success) {
      errors.push({
        message: `invalid record type name "${typeName}": must start with lowercase letter and contain only lowercase letters, digits, underscores, and hyphens`,
        path: `records.${typeName}`,
      });
    }
  }

  return errors;
}

function checkRecordFieldTypes(schema: TilaSchemaToml): SchemaParseError[] {
  const errors: SchemaParseError[] = [];

  for (const [typeName, definition] of Object.entries(schema.records ?? {})) {
    for (const [fieldName, decl] of Object.entries(definition.fields)) {
      if (!VALID_RECORD_FIELD_TYPES.has(decl.type)) {
        errors.push({
          message: `unknown type "${decl.type}"; valid: string, text, enum, list<string>, number, boolean, json`,
          path: `records.${typeName}.fields.${fieldName}.type`,
        });
      }
    }
  }

  return errors;
}

function checkRecordWriters(_schema: TilaSchemaToml): SchemaParseError[] {
  // writers validation is handled at Zod structural phase (z.enum).
  // This stub exists for future semantic checks (e.g., duplicate writer values).
  return [];
}

// --- Public API ---

/**
 * Parse and validate a TOML string as a tila.schema.toml.
 * Non-throwing. Returns a discriminated union with either the parsed schema or errors.
 *
 * Three-phase pipeline:
 * 1. TOML syntax parse (smol-toml)
 * 2. Zod structural validation (TilaSchemaTomlSchema)
 * 3. Semantic/structural checks (circular hierarchy, unknown parents, field types, template entity types)
 */
export function parseSchemaToml(toml: string): ParseSchemaResult {
  // Phase 1: TOML syntax parse
  let raw: Record<string, unknown>;
  try {
    raw = parseTOML(toml) as Record<string, unknown>;
  } catch (e: unknown) {
    const line =
      typeof (e as { line?: unknown }).line === "number"
        ? (e as { line: number }).line
        : undefined;
    const column =
      typeof (e as { column?: unknown }).column === "number"
        ? (e as { column: number }).column
        : undefined;
    return {
      ok: false,
      errors: [
        {
          message: e instanceof Error ? e.message : String(e),
          line,
          column,
        },
      ],
    };
  }

  // Phase 2: Zod structural validation
  const result = TilaSchemaTomlSchema.safeParse(raw);
  if (!result.success) {
    return {
      ok: false,
      errors: zodIssuesToParseErrors(result.error.issues),
    };
  }

  const schema = result.data;

  // Phase 3: Semantic/structural checks
  const semanticErrors: SchemaParseError[] = [
    ...checkUnknownParents(schema),
    ...checkHierarchyLevels(schema),
    ...checkCircularParents(schema),
    ...checkFieldTypes(schema),
    ...checkTemplateEntityTypes(schema),
    ...checkRecordTypeNames(schema),
    ...checkRecordFieldTypes(schema),
    ...checkRecordWriters(schema),
  ];

  if (semanticErrors.length > 0) {
    return { ok: false, errors: semanticErrors };
  }

  return { ok: true, schema };
}

/**
 * Parse and validate a TOML string as a tila.schema.toml.
 * Throwing wrapper around parseSchemaToml. Throws SchemaParseException on failure.
 */
export function parseTilaSchemaToml(toml: string): TilaSchemaToml {
  const result = parseSchemaToml(toml);
  if (!result.ok) {
    throw new SchemaParseException(result.errors);
  }
  return result.schema;
}
