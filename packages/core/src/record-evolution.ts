import type { FieldDeclaration, TilaSchemaToml } from "@tila/schemas";

/**
 * Applies default_for_legacy values for fields present in the record type
 * definition but absent from the record's value. Returns a new value object
 * with injected defaults. Safe to call on any value — returns the unmodified
 * input if no defaults apply.
 *
 * Uses copy-on-write: the input value object is never mutated.
 *
 * For unknown record types (not in schema.records), the value is returned
 * unchanged (passthrough), matching the entity applyLegacyDefaults pattern.
 */
export function applyRecordLegacyDefaults(
  value: Record<string, unknown>,
  schema: TilaSchemaToml,
  recordType: string,
): Record<string, unknown> {
  const recordDef = schema.records?.[recordType];
  if (!recordDef) return value;

  const fields = recordDef.fields as Record<string, FieldDeclaration>;
  let enriched = value;

  for (const [fieldName, declaration] of Object.entries(fields)) {
    const missing = !(fieldName in value);
    const hasDefault = declaration.default_for_legacy !== undefined;
    if (missing && hasDefault) {
      if (enriched === value) {
        enriched = { ...value }; // copy-on-write
      }
      enriched[fieldName] = declaration.default_for_legacy;
    }
  }

  return enriched;
}
