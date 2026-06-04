/**
 * Extract the full-text-searchable title for an entity from its open-schema
 * `data` blob. tila's canonical title field is `data.title`; `data.name` is
 * accepted as a backward-compatible fallback. Returns null when neither is a
 * string (FTS `name` column is nullable).
 *
 * This is the single source of truth for entity title extraction -- used by
 * all three FTS writer sites (entity create, update, and reindex batch).
 * Never inline the precedence logic at a call site (issue #412).
 */
export function entitySearchText(data: Record<string, unknown>): string | null {
  const title = data.title;
  if (typeof title === "string") return title;
  const name = data.name;
  if (typeof name === "string") return name;
  return null;
}
