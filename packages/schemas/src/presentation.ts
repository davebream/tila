// Shared presentation fallbacks for schema-defined content.
//
// A definition may name which declared field is the title or summary. When it
// does, that field wins and an empty value stays empty: clients show the id
// instead of borrowing another field. Without explicit presentation metadata
// the documented fallback is `data.title`, then `data.name`. Nothing here ever
// invents a placeholder such as "Untitled".

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export function presentedTitle(
  data: Record<string, unknown> | null | undefined,
  presentation?: { title?: string } | null,
): string | null {
  if (!data) return null;
  if (presentation?.title) return nonEmptyString(data[presentation.title]);
  return nonEmptyString(data.title) ?? nonEmptyString(data.name);
}

export function presentedText(
  data: Record<string, unknown> | null | undefined,
  field: string | undefined,
): string | null {
  if (!data || !field) return null;
  return nonEmptyString(data[field]);
}
