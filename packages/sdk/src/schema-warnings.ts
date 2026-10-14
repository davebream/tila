import type { SchemaApplyWarning } from "@tila/schemas";

/** Receives each warning after a successful schema apply, including retries. */
export type SchemaWarningSink = (warning: SchemaApplyWarning) => void;

export const defaultSchemaWarningSink: SchemaWarningSink = (warning) => {
  const revisions =
    warning.observed_revision === undefined
      ? `result revision ${warning.result_revision}`
      : `revision ${warning.observed_revision} → ${warning.result_revision}`;
  console.warn(`[tila] ${warning.code}: ${warning.message} (${revisions})`);
};

export function reportSchemaWarnings(
  warnings: SchemaApplyWarning[] | undefined,
  sink: SchemaWarningSink = defaultSchemaWarningSink,
): void {
  for (const warning of warnings ?? []) {
    try {
      sink(warning);
    } catch {
      // A diagnostic failure must never turn a committed write into a failure.
      defaultSchemaWarningSink(warning);
    }
  }
}
