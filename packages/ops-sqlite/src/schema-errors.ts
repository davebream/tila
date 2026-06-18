// ---------------------------------------------------------------------------
// SchemaCorruptError
// ---------------------------------------------------------------------------
//
// Leaf module (no intra-package imports) so that `error-map.ts`,
// `constraint-ops.ts`, and `entity-ops.ts` can all import this class without
// forming a circular import. (error-map imports EntityNotFoundError from
// entity-ops, and entity-ops/constraint-ops throw SchemaCorruptError — keeping
// the class here breaks that cycle, which otherwise left an errorClass
// `undefined` at `mapProjectError`'s `instanceof` check during module init.)

/**
 * Thrown when a stored schema definition (in `_schema_history`) fails to parse.
 *
 * Returned as HTTP 500 `schema-corrupt` (non-retryable) from every backend that
 * calls `resolveCurrentSchema` or `enrichEntity`. A corrupt stored schema is a
 * server-side data-integrity failure; the client cannot remedy it by retrying.
 *
 * C3 design note: `resolveCurrentSchema` previously returned `null` on parse
 * failure, silently skipping all constraint checks. This class implements the
 * fail-closed fix: schema present but unparseable → throw; no schema applied → null.
 */
export class SchemaCorruptError extends Error {
  readonly code = "schema-corrupt" as const;

  constructor(message: string) {
    super(message);
    this.name = "SchemaCorruptError";
  }
}
