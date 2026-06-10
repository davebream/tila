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
