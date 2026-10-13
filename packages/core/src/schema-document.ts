import { parse as parseTOML, stringify as stringifyTOML } from "smol-toml";
import type { SchemaParseError } from "./schema-parser";

/**
 * Editable form of a definition: the raw TOML table tree exactly as parsed,
 * before Zod normalizes it. Editors change known keys in place, so keys the
 * schema does not model (custom or newer fields) survive load, edit and save.
 * The TOML text produced by `serializeDefinitionDocument` is still validated
 * by `parseSchemaToml` and the server preview; this module never validates.
 */
export type DefinitionDocument = Record<string, unknown>;

export type DefinitionTable = Record<string, unknown>;

export type ParseDefinitionDocumentResult =
  | { ok: true; doc: DefinitionDocument }
  | { ok: false; errors: SchemaParseError[] };

/** Sections whose entries are named declarations (`work_units.task`). */
export const DECLARATION_SECTIONS = [
  "work_units",
  "records",
  "artifacts",
  "templates",
] as const;

export type DeclarationSection = (typeof DECLARATION_SECTIONS)[number];

export function isTable(value: unknown): value is DefinitionTable {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Date)
  );
}

/** Parse TOML syntax only. Structural validation is `parseSchemaToml`. */
export function parseDefinitionDocument(
  toml: string,
): ParseDefinitionDocumentResult {
  try {
    return { ok: true, doc: parseTOML(toml) as DefinitionDocument };
  } catch (e: unknown) {
    const at = e as { line?: unknown; column?: unknown };
    return {
      ok: false,
      errors: [
        {
          message: e instanceof Error ? e.message : String(e),
          line: typeof at.line === "number" ? at.line : undefined,
          column: typeof at.column === "number" ? at.column : undefined,
        },
      ],
    };
  }
}

/**
 * Serialize a document back to TOML. Values keep their TOML types (dates stay
 * dates), but layout and comments are not preserved: inline field arrays are
 * written as arrays of tables, and `1.0` is written as `1`.
 */
export function serializeDefinitionDocument(doc: DefinitionDocument): string {
  return stringifyTOML(doc);
}

/** True when the TOML text contains a comment outside string literals. */
export function definitionHasComments(toml: string): boolean {
  let quote: '"' | "'" | '"""' | "'''" | null = null;
  for (let i = 0; i < toml.length; i++) {
    const ch = toml[i];
    if (quote) {
      if (quote === '"' && ch === "\\") {
        i++;
        continue;
      }
      if (quote === '"""' && ch === "\\") {
        i++;
        continue;
      }
      if (quote.length === 3) {
        if (toml.startsWith(quote, i)) {
          i += 2;
          quote = null;
        }
      } else if (ch === quote) {
        quote = null;
      } else if (ch === "\n") {
        quote = null;
      }
      continue;
    }
    if (ch === "#") return true;
    if (ch === '"' || ch === "'") {
      const triple = ch.repeat(3);
      if (toml.startsWith(triple, i)) {
        quote = triple as '"""' | "'''";
        i += 2;
      } else {
        quote = ch;
      }
    }
  }
  return false;
}

/** Deep copy of plain tables and arrays. Dates are immutable here and shared. */
export function cloneValue<T>(value: T): T {
  if (Array.isArray(value)) return value.map(cloneValue) as T;
  if (isTable(value)) {
    const copy: DefinitionTable = {};
    for (const [key, item] of Object.entries(value))
      copy[key] = cloneValue(item);
    return copy as T;
  }
  return value;
}

export function getIn(doc: unknown, path: readonly string[]): unknown {
  let current: unknown = doc;
  for (const key of path) {
    if (!isTable(current)) return undefined;
    current = current[key];
  }
  return current;
}

/**
 * Return a copy of `doc` with `path` set to `value`, creating missing tables.
 * `undefined` removes the key. Sibling keys, including unknown ones, are kept.
 */
export function setIn<T extends DefinitionTable>(
  doc: T,
  path: readonly string[],
  value: unknown,
): T {
  if (path.length === 0) throw new Error("setIn needs a non-empty path");
  const [key, ...rest] = path;
  const copy: DefinitionTable = { ...doc };
  if (rest.length === 0) {
    if (value === undefined) delete copy[key];
    else copy[key] = value;
    return copy as T;
  }
  const child = isTable(copy[key]) ? (copy[key] as DefinitionTable) : {};
  copy[key] = setIn(child, rest, value);
  return copy as T;
}

// --- Field collections -----------------------------------------------------

/**
 * `fields` is written either as an array of `{ name, ... }` tables or as a
 * table keyed by field name. Editors keep whichever shape the author chose.
 */
export type FieldShape = "array" | "table";

export type FieldEntry = {
  name: string;
  /** Raw declaration, including unknown keys. Never contains `name` for arrays. */
  declaration: DefinitionTable;
};

export type FieldCollection = { shape: FieldShape; entries: FieldEntry[] };

export function readFields(fields: unknown): FieldCollection {
  if (Array.isArray(fields)) {
    return {
      shape: "array",
      entries: fields.filter(isTable).map((raw) => {
        const { name, ...declaration } = raw;
        return { name: typeof name === "string" ? name : "", declaration };
      }),
    };
  }
  if (isTable(fields)) {
    return {
      shape: "table",
      entries: Object.entries(fields).map(([name, raw]) => ({
        name,
        declaration: isTable(raw) ? raw : {},
      })),
    };
  }
  return { shape: "array", entries: [] };
}

export function writeFields(collection: FieldCollection): unknown {
  if (collection.shape === "array") {
    return collection.entries.map(({ name, declaration }) => ({
      name,
      ...declaration,
    }));
  }
  return Object.fromEntries(
    collection.entries.map(({ name, declaration }) => {
      // A keyed table may repeat its name inside the declaration; keep it in sync.
      const synced =
        "name" in declaration ? { ...declaration, name } : declaration;
      return [name, synced];
    }),
  );
}

/**
 * Insert or replace a field. `previousName` renames in place, keeping order;
 * `null` appends a new field.
 */
export function putField(
  fields: unknown,
  previousName: string | null,
  entry: FieldEntry,
): unknown {
  const collection = readFields(fields);
  const index =
    previousName === null
      ? -1
      : collection.entries.findIndex((f) => f.name === previousName);
  const entries = [...collection.entries];
  if (index === -1) entries.push(entry);
  else entries[index] = entry;
  return writeFields({ shape: collection.shape, entries });
}

export function removeField(fields: unknown, name: string): unknown {
  const collection = readFields(fields);
  return writeFields({
    shape: collection.shape,
    entries: collection.entries.filter((f) => f.name !== name),
  });
}

export function duplicateField(
  fields: unknown,
  name: string,
  copyName: string,
): unknown {
  const collection = readFields(fields);
  const source = collection.entries.find((f) => f.name === name);
  if (!source) return fields;
  return putField(fields, null, {
    name: copyName,
    declaration: cloneValue(source.declaration),
  });
}

// --- Declarations ----------------------------------------------------------

export function declarationNames(
  doc: DefinitionDocument,
  section: DeclarationSection,
): string[] {
  const table = doc[section];
  return isTable(table) ? Object.keys(table) : [];
}

/** Copy a declaration, unknown keys included, under a new unused name. */
export function cloneDeclaration(
  doc: DefinitionDocument,
  section: DeclarationSection,
  from: string,
  to: string,
): DefinitionDocument {
  const source = getIn(doc, [section, from]);
  if (!isTable(source)) throw new Error(`${section}.${from} does not exist`);
  if (getIn(doc, [section, to]) !== undefined) {
    throw new Error(`${section}.${to} already exists`);
  }
  return setIn(doc, [section, to], cloneValue(source));
}

/**
 * Remove a declaration. Retirement has no flag: the preview reports what the
 * removal affects, and existing rows stay readable as legacy data.
 */
export function removeDeclaration(
  doc: DefinitionDocument,
  section: DeclarationSection,
  name: string,
): DefinitionDocument {
  return setIn(doc, [section, name], undefined);
}

/** Unique copy name: `name_copy`, `name_copy_2`, ... */
export function copyName(existing: readonly string[], name: string): string {
  const taken = new Set(existing);
  let candidate = `${name}_copy`;
  for (let n = 2; taken.has(candidate); n++) candidate = `${name}_copy_${n}`;
  return candidate;
}

// --- Rebase ----------------------------------------------------------------

/**
 * A unit that merges independently: one declaration (`work_units.task`) or one
 * other top-level key (`hierarchy`, `schema_version`, a custom key).
 */
export type RebaseUnit = { path: string; keys: readonly string[] };

export type RebaseResult = {
  merged: DefinitionDocument;
  /** Units both sides changed differently. Without a resolution, theirs wins. */
  conflicts: string[];
};

/** Order-insensitive comparison key; dates compare by instant. */
function canonical(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (v instanceof Date) return { $date: v.toISOString() };
    if (Array.isArray(v)) return v.map(sort);
    if (isTable(v)) {
      return Object.fromEntries(
        Object.keys(v)
          .sort()
          .map((k) => [k, sort(v[k])]),
      );
    }
    return v;
  };
  return JSON.stringify(sort(value) ?? null);
}

/** Deep equality ignoring key order; dates compare by instant. */
export function sameDefinitionValue(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

/**
 * Every unit that appears in any of `docs`, in first-seen order. An empty
 * declaration section contributes no units; a non-table one contributes none.
 */
export function definitionUnits(...docs: DefinitionDocument[]): RebaseUnit[] {
  const units = new Map<string, RebaseUnit>();
  for (const doc of docs) {
    for (const key of Object.keys(doc)) {
      const section = DECLARATION_SECTIONS.find((s) => s === key);
      if (section && isTable(doc[key])) {
        for (const name of Object.keys(doc[key] as DefinitionTable)) {
          const path = `${section}.${name}`;
          units.set(path, { path, keys: [section, name] });
        }
      } else if (!section) {
        units.set(key, { path: key, keys: [key] });
      }
    }
  }
  return [...units.values()];
}

/**
 * Three-way merge of a draft onto a newer revision, one declaration at a time.
 * A side that left a unit unchanged takes the other side's version. When both
 * changed it differently, `resolutions[path]` picks the winner.
 */
export function rebaseDefinition(
  base: DefinitionDocument,
  mine: DefinitionDocument,
  latest: DefinitionDocument,
  resolutions: Readonly<Record<string, "mine" | "theirs">> = {},
): RebaseResult {
  let merged = cloneValue(latest);
  const conflicts: string[] = [];
  for (const unit of definitionUnits(base, mine, latest)) {
    const b = canonical(getIn(base, unit.keys));
    const m = canonical(getIn(mine, unit.keys));
    const l = canonical(getIn(latest, unit.keys));
    if (m === b || m === l) continue;
    if (l !== b) {
      conflicts.push(unit.path);
      if (resolutions[unit.path] !== "mine") continue;
    }
    merged = setIn(merged, unit.keys, cloneValue(getIn(mine, unit.keys)));
  }
  // Removing the last declaration can leave an empty section; drop it so the
  // result serializes like a hand-written file.
  for (const section of DECLARATION_SECTIONS) {
    const table = merged[section];
    if (
      isTable(table) &&
      Object.keys(table).length === 0 &&
      !(section in latest)
    ) {
      merged = setIn(merged, [section], undefined);
    }
  }
  return { merged, conflicts };
}

export type DefinitionUnitComparison = {
  /** Units only `after` has. */
  added: string[];
  /** Units both have, with different values. */
  changed: string[];
  unchanged: string[];
  /** Units only `before` has. */
  removed: string[];
};

/** Classify each unit of two documents by how it differs between them. */
export function compareDefinitionUnits(
  before: DefinitionDocument,
  after: DefinitionDocument,
): DefinitionUnitComparison {
  const result: DefinitionUnitComparison = {
    added: [],
    changed: [],
    unchanged: [],
    removed: [],
  };
  for (const unit of definitionUnits(before, after)) {
    const from = getIn(before, unit.keys);
    const to = getIn(after, unit.keys);
    if (from === undefined) result.added.push(unit.path);
    else if (to === undefined) result.removed.push(unit.path);
    else if (sameDefinitionValue(from, to)) result.unchanged.push(unit.path);
    else result.changed.push(unit.path);
  }
  return result;
}
