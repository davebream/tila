import type { SchemaApplyWarning } from "@tila/schemas";

/** Receives each warning after a successful schema apply, including retries. */
export type SchemaWarningSink = (warning: SchemaApplyWarning) => void;

export const defaultSchemaWarningSink: SchemaWarningSink = (warning) => {
  try {
    const revisions =
      warning.observed_revision === undefined
        ? `result revision ${warning.result_revision}`
        : `revision ${warning.observed_revision} → ${warning.result_revision}`;
    // Replaced console implementations can throw or return a rejected promise.
    // Diagnostics must never change the outcome of an already committed apply.
    void Promise.resolve(
      console.warn(`[tila] ${warning.code}: ${warning.message} (${revisions})`),
    ).catch(() => {});
  } catch {
    // There is no further diagnostic channel to try safely.
  }
};

export function reportSchemaWarnings(
  warnings: SchemaApplyWarning[] | undefined,
  sink: SchemaWarningSink = defaultSchemaWarningSink,
): void {
  for (const warning of warnings ?? []) {
    try {
      // Async functions are assignable to a void callback. Observe their
      // rejection without delaying the apply or leaking an unhandled rejection.
      void Promise.resolve(sink(warning)).catch(() =>
        defaultSchemaWarningSink(warning),
      );
    } catch {
      // A diagnostic failure must never turn a committed write into a failure.
      defaultSchemaWarningSink(warning);
    }
  }
}
