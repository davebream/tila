import {
  type SchemaRecord,
  currentDefinition,
  parseSchemaToml,
} from "@tila/core";
import { LIFECYCLE_OUTCOMES, type LifecycleOutcome } from "@tila/schemas";
import { TILA_ERRORS } from "tila-sdk";

/**
 * `task close --outcome` words from before lifecycle outcomes existed. They map
 * onto the canonical outcome the applied lifecycle declares a state for.
 */
const LEGACY_OUTCOME_ALIASES = new Map<string, LifecycleOutcome>([
  ["completed", "success"],
  ["deferred", "abandoned"],
]);

export const CLOSE_OUTCOME_HELP = `${LIFECYCLE_OUTCOMES.join("|")} (aliases: ${[
  ...LEGACY_OUTCOME_ALIASES,
]
  .map(([alias, outcome]) => `${alias}=${outcome}`)
  .join(", ")})`;

/** Carries a machine code and an actionable hint for `failWithCliError`. */
export class TaskCloseError extends Error {
  constructor(
    public code: string,
    message: string,
    public hint?: string,
  ) {
    super(message);
    this.name = "TaskCloseError";
  }
}

export type TaskCloseTarget = {
  /** Entity type whose lifecycle was consulted. */
  type: string;
  /** Lifecycle field the close writes, and the only field it writes. */
  field: string;
  /** Terminal state the declared lifecycle names for the outcome. */
  state: string;
  /** Canonical lifecycle outcome after alias resolution. */
  outcome: LifecycleOutcome;
};

/** Resolve the CLI word to a canonical outcome, or throw before any I/O. */
export function parseCloseOutcome(raw: unknown): LifecycleOutcome {
  if (typeof raw === "string") {
    const word = raw.trim();
    const aliased = LEGACY_OUTCOME_ALIASES.get(word);
    if (aliased) return aliased;
    const canonical = LIFECYCLE_OUTCOMES.find((outcome) => outcome === word);
    if (canonical) return canonical;
  }
  throw new TaskCloseError(
    TILA_ERRORS.VALIDATION_ERROR,
    `Invalid outcome "${String(raw)}". Accepted: ${CLOSE_OUTCOME_HELP}`,
  );
}

function lifecycleHint(type: string): string {
  return `Declare [work_units.${type}.lifecycle] (field, dispatchable, terminal, dependency_satisfied) and [work_units.${type}.lifecycle.outcomes] in the project schema, then run \`tila schema apply\`. Existing projects are not migrated automatically.`;
}

/**
 * Choose the terminal state `task close` writes from the applied definition.
 * Fails closed: with no readable schema, no lifecycle for the task's type, or
 * no terminal state mapped to the outcome, nothing is returned to write.
 */
export function resolveCloseTarget(
  record: SchemaRecord,
  type: string,
  outcome: LifecycleOutcome,
): TaskCloseTarget {
  let source: string | null;
  try {
    source = currentDefinition(record).source;
  } catch {
    // The stored text may hold credentials, so no parser detail is repeated.
    throw new TaskCloseError(
      TILA_ERRORS.CONSTRAINT_VIOLATION,
      "The applied schema could not be read, so the task was not closed",
      "Inspect it with `tila schema show` and apply a corrected definition.",
    );
  }
  if (source === null) {
    throw new TaskCloseError(
      TILA_ERRORS.CONSTRAINT_VIOLATION,
      "No schema is applied, so there is no declared terminal state to close the task into",
      lifecycleHint(type),
    );
  }
  const parsed = parseSchemaToml(source);
  if (!parsed.ok) {
    throw new TaskCloseError(
      TILA_ERRORS.CONSTRAINT_VIOLATION,
      "The applied schema is not valid, so the task was not closed",
      "Inspect it with `tila schema show` and apply a corrected definition.",
    );
  }
  const unit = parsed.schema.work_units[type];
  if (!unit) {
    throw new TaskCloseError(
      TILA_ERRORS.CONSTRAINT_VIOLATION,
      `Task type "${type}" is not declared in the applied schema`,
    );
  }
  const lifecycle = unit.lifecycle;
  if (!lifecycle) {
    throw new TaskCloseError(
      TILA_ERRORS.CONSTRAINT_VIOLATION,
      `work_units.${type} declares no lifecycle, so there is no terminal state to close the task into`,
      lifecycleHint(type),
    );
  }
  const state = lifecycle.outcomes?.[outcome];
  if (state === undefined) {
    throw new TaskCloseError(
      TILA_ERRORS.CONSTRAINT_VIOLATION,
      `work_units.${type}.lifecycle.outcomes does not map outcome "${outcome}" to a state`,
      `Add \`${outcome} = "<terminal state>"\` under [work_units.${type}.lifecycle.outcomes], then run \`tila schema apply\`.`,
    );
  }
  if (!lifecycle.terminal.includes(state)) {
    throw new TaskCloseError(
      TILA_ERRORS.CONSTRAINT_VIOLATION,
      `work_units.${type}.lifecycle.outcomes maps "${outcome}" to "${state}", which is not a terminal state`,
      `List "${state}" under work_units.${type}.lifecycle.terminal or map the outcome to a terminal state.`,
    );
  }
  return { type, field: lifecycle.field, state, outcome };
}
