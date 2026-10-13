// Type catalogs (#300): which task and record types a caller may read, built
// independently of any page of result rows.
//
// Declared types come from the current schema; in-use types come from stored
// rows. A declared type with no rows is still listed (count 0), and a stored
// type the schema no longer declares stays listed as `undeclared` so its rows
// remain reachable. Namespace-restricted callers only ever see permitted
// types, declared or not, and never learn the schema's fetch/parse state.

import {
  type CatalogField,
  type CatalogIncomplete,
  type FieldDeclaration,
  type NamespaceRestrictions,
  type RecordCatalogEntry,
  type RecordDefinition,
  type ResultScope,
  type TilaSchemaToml,
  type TypeCount,
  type TypeDeclaration,
  type WorkCatalogEntry,
  type WorkUnit,
  permitsTask,
} from "@tila/schemas";

/** What the caller could learn about the current schema. */
export type CatalogSchemaState =
  | { state: "ok"; schema: TilaSchemaToml }
  /** No schema is configured: a complete answer with nothing declared. */
  | { state: "none" }
  | { state: "unavailable" }
  | { state: "invalid" };

export interface CatalogInput {
  schema: CatalogSchemaState;
  /** Stored-row counts already filtered by the caller's restrictions; `null` when they could not be read. */
  counts: TypeCount[] | null;
  restrictions?: NamespaceRestrictions;
}

export interface Catalog<Entry> {
  types: Entry[];
  scope: ResultScope;
  incomplete?: CatalogIncomplete;
}

function catalogFields(
  fields: Record<string, FieldDeclaration> | undefined,
): CatalogField[] {
  return Object.entries(fields ?? {}).map(([name, field]) => ({
    name,
    type: field.type,
    required: field.required ?? false,
    ...(field.values ? { values: field.values } : {}),
    ...(field.default !== undefined ? { default: field.default } : {}),
  }));
}

function hasRestrictions(restrictions?: NamespaceRestrictions): boolean {
  return (
    restrictions?.task_types !== undefined ||
    restrictions?.records !== undefined
  );
}

function buildCatalog<Definition, Entry>(
  input: CatalogInput,
  declared: Record<string, Definition>,
  permitted: (type: string) => boolean,
  restrictedKind: boolean,
  toEntry: (
    type: string,
    declaration: TypeDeclaration,
    count: TypeCount,
    definition: Definition | undefined,
  ) => Entry,
): Catalog<Entry> {
  const incomplete: CatalogIncomplete = {};
  if (input.schema.state === "unavailable")
    incomplete.declared_types = "unavailable";
  if (input.schema.state === "invalid") incomplete.declared_types = "invalid";
  if (input.counts === null) incomplete.in_use_types = "unavailable";

  const counts = new Map<string, TypeCount>();
  for (const row of input.counts ?? []) {
    if (permitted(row.type)) counts.set(row.type, row);
  }
  const declaredTypes = Object.keys(declared).filter(permitted);
  const names = [...new Set([...declaredTypes, ...counts.keys()])].sort();

  // A restricted caller must not learn the schema's fetch/parse state, so for
  // them an unreadable schema reads exactly like "nothing declared" (the
  // records types response has always behaved this way).
  const restricted = hasRestrictions(input.restrictions);
  const schemaUnreadable =
    input.schema.state === "unavailable" || input.schema.state === "invalid";
  const types = names.map((type) => {
    const definition = Object.hasOwn(declared, type)
      ? declared[type]
      : undefined;
    const declaration: TypeDeclaration =
      schemaUnreadable && !restricted
        ? "unknown"
        : definition !== undefined
          ? "declared"
          : "undeclared";
    const count = counts.get(type) ?? { type, count: 0, archived_count: 0 };
    return toEntry(type, declaration, count, definition);
  });

  const reportIncomplete = Object.keys(incomplete).length > 0 && !restricted;
  return {
    types,
    scope: { restricted: restrictedKind },
    ...(reportIncomplete ? { incomplete } : {}),
  };
}

export function buildWorkCatalog(
  input: CatalogInput,
): Catalog<WorkCatalogEntry> {
  const declared: Record<string, WorkUnit> =
    input.schema.state === "ok" ? input.schema.schema.work_units : {};
  return buildCatalog(
    input,
    declared,
    (type) => permitsTask(input.restrictions, type),
    input.restrictions?.task_types !== undefined,
    (type, declaration, count, unit) => ({
      type,
      declaration,
      count: count.count,
      archived_count: count.archived_count,
      ...(unit
        ? {
            definition: {
              fields: catalogFields(unit.fields),
              ...(unit.lifecycle ? { lifecycle: unit.lifecycle } : {}),
              ...(unit.presentation ? { presentation: unit.presentation } : {}),
            },
          }
        : {}),
    }),
  );
}

/**
 * A record type is permitted when the caller is unrestricted for records, or
 * holds a rule for the type that is not narrowed to zero key prefixes.
 */
export function permitsRecordType(
  restrictions: NamespaceRestrictions | undefined,
  type: string,
): boolean {
  if (restrictions?.records === undefined) return true;
  return restrictions.records.some(
    (rule) =>
      rule.type === type &&
      (rule.key_prefixes === undefined || rule.key_prefixes.length > 0),
  );
}

export function buildRecordCatalog(
  input: CatalogInput,
): Catalog<RecordCatalogEntry> {
  const declared: Record<string, RecordDefinition> =
    input.schema.state === "ok" ? (input.schema.schema.records ?? {}) : {};
  return buildCatalog(
    input,
    declared,
    (type) => permitsRecordType(input.restrictions, type),
    input.restrictions?.records !== undefined,
    (type, declaration, count, definition) => ({
      type,
      declaration,
      count: count.count,
      archived_count: count.archived_count,
      ...(definition
        ? {
            definition: {
              fields: catalogFields(definition.fields),
              format: definition.format,
              history: definition.history,
              ...(definition.presentation
                ? { presentation: definition.presentation }
                : {}),
              ...(definition.key_description
                ? { key_description: definition.key_description }
                : {}),
              ...(definition.writers ? { writers: definition.writers } : {}),
            },
          }
        : {}),
    }),
  );
}
