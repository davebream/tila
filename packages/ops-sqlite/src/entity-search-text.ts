import { type WorkPresentation, presentedTitle } from "@tila/schemas";

/**
 * Extract the full-text-searchable title for an entity from its open-schema
 * `data` blob. When the type declares `presentation.title`, that field is the
 * title; otherwise `data.title`, then `data.name` (backward-compatible
 * fallback). Returns null when there is no non-empty string title (FTS `name`
 * column is nullable).
 *
 * This is the single source of truth for entity title extraction -- used by
 * all three FTS writer sites (entity create, update, and reindex batch).
 * Never inline the precedence logic at a call site (issue #412).
 */
export function entitySearchText(
  data: Record<string, unknown>,
  presentation?: WorkPresentation,
): string | null {
  return presentedTitle(data, presentation);
}
