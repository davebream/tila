import { type DefinitionTable, isTable } from "@tila/core";

/** Field types a work type may declare; records also allow the last three. */
export const WORK_FIELD_TYPES = ["string", "text", "enum", "list<string>"];
export const RECORD_FIELD_TYPES = [
  ...WORK_FIELD_TYPES,
  "number",
  "boolean",
  "json",
];

/** One value per line; blank lines are dropped. */
export function splitLines(raw: string): string[] {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];
}

/**
 * Text shown for a declared default of `type`. The inverse is
 * `parseFieldValue`; unset is the empty string.
 */
export function formatFieldValue(type: string, value: unknown): string {
  if (value === undefined) return "";
  if (type === "list<string>" && Array.isArray(value))
    return value.map(String).join("\n");
  if (type === "json") return JSON.stringify(value, null, 2);
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

export type ParsedValue =
  | { ok: true; value: unknown }
  | { ok: false; message: string };

/** Convert input text to the TOML value stored for a field of `type`. */
export function parseFieldValue(type: string, raw: string): ParsedValue {
  if (raw.trim() === "") return { ok: true, value: undefined };
  switch (type) {
    case "list<string>":
      return { ok: true, value: splitLines(raw) };
    case "number": {
      const value = Number(raw);
      return Number.isFinite(value)
        ? { ok: true, value }
        : { ok: false, message: "Enter a number." };
    }
    case "boolean":
      return raw === "true" || raw === "false"
        ? { ok: true, value: raw === "true" }
        : { ok: false, message: "Choose true or false." };
    case "json":
      try {
        return { ok: true, value: JSON.parse(raw) };
      } catch {
        return { ok: false, message: "Enter valid JSON." };
      }
    default:
      return { ok: true, value: raw };
  }
}

/**
 * Set or remove one known key on a raw declaration. Other keys, including
 * ones the editor does not model, are untouched. Empty values remove the key
 * so an unused option does not appear in the TOML.
 */
export function put(
  table: DefinitionTable,
  key: string,
  value: unknown,
): DefinitionTable {
  const next = { ...table };
  const empty =
    value === undefined ||
    value === "" ||
    (Array.isArray(value) && value.length === 0) ||
    (isTable(value) && Object.keys(value).length === 0);
  if (empty) delete next[key];
  else next[key] = value;
  return next;
}

/**
 * Set a key that has a schema default. Choosing the default leaves an absent
 * key absent, and keeps a key the author wrote explicitly.
 */
export function putDefault(
  table: DefinitionTable,
  key: string,
  value: unknown,
  fallback: unknown,
): DefinitionTable {
  if (value === fallback && !(key in table)) return table;
  return { ...table, [key]: value };
}

export function tableAt(table: DefinitionTable, key: string): DefinitionTable {
  const value = table[key];
  return isTable(value) ? value : {};
}

export function stringAt(table: DefinitionTable, key: string): string {
  const value = table[key];
  return typeof value === "string" ? value : "";
}

/** `base`, or `base_2`, `base_3`, ... when taken. */
export function freshName(existing: readonly string[], base: string): string {
  const taken = new Set(existing);
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}_${n}`)) n++;
  return `${base}_${n}`;
}
