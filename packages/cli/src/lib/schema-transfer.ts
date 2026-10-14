import type { SchemaParseError } from "@tila/core";

export { type CurrentDefinition, currentDefinition } from "@tila/core";

/** An Error carrying the CLI's structured `code` and optional `hint`. */
export function cliError(code: string, message: string, hint?: string) {
  return Object.assign(new Error(message), { code, hint });
}

/** One line per error: `path: message (line L, column C)`. */
export function formatDefinitionErrors(
  errors: readonly SchemaParseError[],
): string {
  return errors
    .map((e) => {
      const where =
        e.line !== undefined
          ? ` (line ${e.line}${e.column !== undefined ? `, column ${e.column}` : ""})`
          : "";
      return `  ${e.path ? `${e.path}: ` : ""}${e.message}${where}`;
    })
    .join("\n");
}

/**
 * Human-readable line for one schema change, from `diffSchemas` or the server
 * preview (which adds `entityCount`/`recordCount` impact counts).
 */
export function describeSchemaChange(rawChange: unknown): string {
  const change = rawChange as Record<string, unknown>;
  const kind = change.kind as string;
  switch (kind) {
    case "work-unit-added":
      return `  + Added work-unit type: ${change.unitType}`;
    case "work-unit-removed": {
      const count = (change.entityCount as number | undefined) ?? 0;
      const suffix =
        count > 0
          ? ` (${count} active ${count === 1 ? "entity" : "entities"} would be orphaned)`
          : "";
      return `  - Removed work-unit type: ${change.unitType}${suffix}`;
    }
    case "field-added":
      return `  + Added field '${change.fieldName}' to ${change.unitType} (optional)`;
    case "field-removed": {
      const count = (change.entityCount as number | undefined) ?? 0;
      const suffix =
        count > 0
          ? ` (${count} active ${count === 1 ? "entity" : "entities"} affected)`
          : "";
      return `  - Removed field '${change.fieldName}' from ${change.unitType}${suffix}`;
    }
    case "field-required-added":
      return `  + Added required field '${change.fieldName}' to ${change.unitType}`;
    case "artifact-kind-added":
      return `  + Added artifact kind: ${change.artifactKind}`;
    case "artifact-kind-removed":
      return `  - Removed artifact kind: ${change.artifactKind}`;
    case "record-type-added":
      return `  + Added record type: ${change.typeName}`;
    case "record-type-removed": {
      const count = (change.recordCount as number | undefined) ?? 0;
      const suffix =
        count > 0
          ? ` (${count} active ${count === 1 ? "record" : "records"} would be orphaned)`
          : "";
      return `  - Removed record type: ${change.typeName}${suffix}`;
    }
    case "record-field-added":
      return `  + Added field '${change.fieldName}' to record type ${change.typeName}`;
    case "record-field-removed":
      return `  - Removed field '${change.fieldName}' from record type ${change.typeName}`;
    case "record-field-required-added":
      return `  + Added required field '${change.fieldName}' to record type ${change.typeName}`;
    case "definition-changed":
      return `  ~ Changed ${change.path}${change.destructive ? " (review required)" : ""}`;
    default:
      return `  ~ ${kind}`;
  }
}

/** Parse `--expected-revision` for definitions, where 0 means "nothing applied yet". */
export function definitionRevisionFlag(
  raw: string | undefined,
): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0)
    throw cliError(
      "invalid-argument",
      "--expected-revision must be a nonnegative integer (0 before the first apply)",
    );
  return value;
}
