import { FenceError } from "@tila/core";
import { DoIdempotencyConflictError } from "./do-idempotency-ops";
import { EntityAlreadyExistsError, EntityNotFoundError } from "./entity-ops";
import {
  ClaimOwnershipError,
  ExpiredClaimError,
  FenceNotFoundError,
} from "./fence-ops";
import {
  GateAlreadySettledError,
  GateBlockedError,
  GateFenceError,
  GateNotFoundError,
} from "./gate-ops";
import {
  RecordAlreadyExistsError,
  RecordInvalidStateError,
  RecordNotFoundError,
  RevisionNotFoundError,
} from "./record-ops";
// SchemaCorruptError lives in the leaf module ./schema-errors to avoid a
// circular import: error-map imports EntityNotFoundError from entity-ops, and
// entity-ops/constraint-ops throw SchemaCorruptError — co-locating the class
// here left an errorClass `undefined` at mapProjectError's instanceof during
// module init. Imported for local use in projectErrorResponses and re-exported
// for back-compat (index.ts and downstream import it from here).
import { SchemaCorruptError } from "./schema-errors";

export { SchemaCorruptError } from "./schema-errors";

// ---------------------------------------------------------------------------
// Error map types
// ---------------------------------------------------------------------------

type ProjectErrorConstructor =
  | typeof FenceError
  | typeof ClaimOwnershipError
  | typeof ExpiredClaimError
  | typeof GateNotFoundError
  | typeof GateAlreadySettledError
  | typeof FenceNotFoundError
  | typeof GateFenceError
  | typeof GateBlockedError
  | typeof RecordAlreadyExistsError
  | typeof RecordNotFoundError
  | typeof RecordInvalidStateError
  | typeof RevisionNotFoundError
  | typeof EntityAlreadyExistsError
  | typeof EntityNotFoundError
  | typeof DoIdempotencyConflictError
  | typeof SchemaCorruptError;

export type ProjectErrorResponse = {
  errorClass: ProjectErrorConstructor;
  status: number;
  code: string;
  retryable: boolean;
  extras?: (err: Error) => Record<string, unknown>;
};

export const projectErrorResponses: ProjectErrorResponse[] = [
  {
    errorClass: FenceError,
    status: 409,
    code: "stale-fence",
    retryable: false,
  },
  // An expired/released entity lease is a stale-fence condition from the
  // client's perspective: the remedy is to re-acquire, same as FenceError.
  {
    errorClass: ExpiredClaimError,
    status: 409,
    code: "stale-fence",
    retryable: false,
  },
  {
    errorClass: ClaimOwnershipError,
    status: 403,
    code: "release-ownership-denied",
    retryable: false,
  },
  {
    errorClass: GateNotFoundError,
    status: 404,
    code: "not-found",
    retryable: false,
  },
  {
    errorClass: GateAlreadySettledError,
    status: 409,
    code: "gate-already-settled",
    retryable: false,
  },
  {
    errorClass: FenceNotFoundError,
    status: 400,
    code: "no-fence",
    retryable: false,
  },
  {
    errorClass: GateFenceError,
    status: 409,
    code: "gate-fence-conflict",
    retryable: false,
  },
  {
    errorClass: GateBlockedError,
    status: 409,
    code: "gate-blocked",
    retryable: false,
    extras: (err) => ({ gateIds: (err as GateBlockedError).gateIds }),
  },
  {
    errorClass: RecordAlreadyExistsError,
    status: 409,
    code: "conflict",
    retryable: false,
  },
  {
    errorClass: RecordNotFoundError,
    status: 404,
    code: "not-found",
    retryable: false,
  },
  {
    errorClass: RecordInvalidStateError,
    status: 409,
    code: "invalid-state",
    retryable: false,
  },
  {
    errorClass: RevisionNotFoundError,
    status: 404,
    code: "not-found",
    retryable: false,
  },
  {
    errorClass: EntityAlreadyExistsError,
    status: 409,
    code: "already-exists",
    retryable: false,
  },
  {
    errorClass: EntityNotFoundError,
    status: 404,
    code: "not-found",
    retryable: false,
  },
  // Same Idempotency-Key reused with a different body — mirrors the worker
  // idempotency middleware's 422 `idempotency-key-conflict`.
  {
    errorClass: DoIdempotencyConflictError,
    status: 422,
    code: "idempotency-key-conflict",
    retryable: false,
  },
  // Corrupt stored schema — server-side data-integrity failure, not retryable.
  {
    errorClass: SchemaCorruptError,
    status: 500,
    code: "schema-corrupt",
    retryable: false,
  },
];

export function mapProjectError(err: Error): {
  status: number;
  code: string;
  retryable: boolean;
  extras?: Record<string, unknown>;
} | null {
  for (const rule of projectErrorResponses) {
    if (err instanceof rule.errorClass) {
      return {
        status: rule.status,
        code: rule.code,
        retryable: rule.retryable,
        extras: rule.extras?.(err),
      };
    }
  }
  return null;
}
