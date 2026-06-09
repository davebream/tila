import type { Entity } from "@tila/schemas";

/**
 * Filter an entity to only the requested fields.
 * Flattens data sub-fields to top-level for field-selection responses.
 */
export function filterFields(
  entity: Entity,
  fields: string[],
): Record<string, unknown> {
  const data = entity.data as Record<string, unknown>;
  const flat: Record<string, unknown> = {
    id: entity.id,
    type: entity.type,
    schema_version: entity.schema_version,
    archived: entity.archived,
    created_at: entity.created_at,
    updated_at: entity.updated_at,
    created_by: entity.created_by,
    tags: entity.tags,
    ...data,
  };
  const result: Record<string, unknown> = {};
  for (const f of fields) {
    if (f in flat) result[f] = flat[f];
  }
  return result;
}
