/**
 * Embedded-backend error types.
 *
 * Mirrors the named-Error convention used elsewhere in the embedded/ops layer
 * (e.g. `FenceError`, `RecordInvalidStateError`): a typed `Error` subclass with
 * a stable `.name` and a machine-readable `code`. The CLI/SDK/MCP consumers map
 * this to a clear message, matching how the Worker turns the same DO-route
 * constraint failure into a 422 with `code: "constraint-violation"`.
 */

/**
 * A record mutation violated a schema constraint (undeclared record type, or a
 * value missing a required field). Thrown by `EmbeddedProject` on the same
 * paths the DO route returns a 422 `constraint-violation`.
 */
export class RecordConstraintError extends Error {
  readonly code = "constraint-violation" as const;

  constructor(message: string) {
    super(message);
    this.name = "RecordConstraintError";
  }
}

/**
 * A referenced resource (entity or artifact) does not exist. Thrown by
 * `EmbeddedProject` on the same paths the DO route returns a 404 `not-found`
 * — e.g. `addArtifactRef` against a missing entity or a missing artifact
 * pointer. Carries a clean message instead of leaking a raw SQLite
 * `FOREIGN KEY constraint failed` string (DO parity, entity-routes.ts ~552/586).
 */
export class NotFoundError extends Error {
  readonly code = "not-found" as const;

  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

/**
 * A reference (entity-artifact) violated a schema constraint — e.g. an
 * undeclared reference slot, or a CHECK constraint on entity_id/artifact_key.
 * Thrown by `EmbeddedProject` on the same paths the DO route returns a 422
 * `constraint-violation` / 400 `bad-request` (entity-routes.ts ~568/594).
 */
export class ReferenceConstraintError extends Error {
  readonly code = "constraint-violation" as const;

  constructor(message: string) {
    super(message);
    this.name = "ReferenceConstraintError";
  }
}

/**
 * A template instantiation failed locally — no schema applied, template not
 * found, an undeclared work-unit type, or an invalid computed entity ID.
 * Mirrors the DO `/template/instantiate` route's error set (schema-routes.ts
 * ~136-178): no-schema (422), not-found (404), constraint-violation (422),
 * invalid-id (422). Carries a clean message so the CLI/SDK/MCP surface the same
 * actionable error locally as remote, with no stack trace.
 */
export class TemplateError extends Error {
  readonly code:
    | "no-schema"
    | "not-found"
    | "constraint-violation"
    | "invalid-id";

  constructor(
    code: "no-schema" | "not-found" | "constraint-violation" | "invalid-id",
    message: string,
  ) {
    super(message);
    this.name = "TemplateError";
    this.code = code;
  }
}
