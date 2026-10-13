import type { CatalogField } from "@tila/schemas";

/**
 * Form inputs are kept as plain strings so a draft survives sessionStorage
 * unchanged; they are converted to stored values only on submit.
 */
export type RawFields = Record<string, string>;

export function isListType(type: string): boolean {
  return /^list<.+>$/.test(type);
}

/** The editable string for one stored value. */
export function toRaw(field: CatalogField, value: unknown): string {
  if (value === undefined || value === null) return "";
  if (isListType(field.type))
    return Array.isArray(value) ? value.map(String).join("\n") : String(value);
  if (field.type === "json") return JSON.stringify(value, null, 2);
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  return JSON.stringify(value);
}

/** Initial inputs: stored values, else declared defaults for new rows. */
export function rawFields(
  fields: CatalogField[],
  data: Record<string, unknown> | null,
): RawFields {
  return Object.fromEntries(
    fields.map((field) => [
      field.name,
      toRaw(field, data ? data[field.name] : field.default),
    ]),
  );
}

export type FieldConversion =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; errors: Record<string, string> };

/**
 * Convert inputs back to stored values and check what the schema declares:
 * required presence, enum membership and number/boolean/JSON syntax.
 *
 * Empty optional inputs are omitted, except that a field the row already had
 * is sent as `null` (`clearAs`) so a shallow-merge update actually clears it.
 */
export function fromRaw(
  fields: CatalogField[],
  raw: RawFields,
  options: { previous?: Record<string, unknown>; skip?: Set<string> } = {},
): FieldConversion {
  const data: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  for (const field of fields) {
    if (options.skip?.has(field.name)) continue;
    const input = raw[field.name] ?? "";
    const blank = input.trim() === "";
    if (blank) {
      if (field.required) errors[field.name] = "Required.";
      else if (
        options.previous &&
        options.previous[field.name] !== undefined &&
        options.previous[field.name] !== null
      )
        data[field.name] = null;
      continue;
    }
    if (isListType(field.type)) {
      data[field.name] = input
        .split("\n")
        .map((item) => item.trim())
        .filter(Boolean);
    } else if (field.type === "number") {
      const value = Number(input);
      if (Number.isFinite(value)) data[field.name] = value;
      else errors[field.name] = "Enter a number.";
    } else if (field.type === "boolean") {
      if (input === "true" || input === "false")
        data[field.name] = input === "true";
      else errors[field.name] = "Choose yes or no.";
    } else if (field.type === "json") {
      try {
        data[field.name] = JSON.parse(input);
      } catch {
        errors[field.name] = "Enter valid JSON.";
      }
    } else {
      if (field.values && !field.values.includes(input))
        errors[field.name] = `Choose one of: ${field.values.join(", ")}.`;
      else data[field.name] = input;
    }
  }
  return Object.keys(errors).length > 0
    ? { ok: false, errors }
    : { ok: true, data };
}

/** Only keys whose stored value would change (for a shallow-merge PATCH). */
export function changedData(
  next: Record<string, unknown>,
  previous: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(next).filter(
      ([key, value]) =>
        JSON.stringify(value) !== JSON.stringify(previous[key] ?? null),
    ),
  );
}
