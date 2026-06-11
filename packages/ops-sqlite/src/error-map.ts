import { FenceError } from "@tila/core";
import { EntityAlreadyExistsError, EntityNotFoundError } from "./entity-ops";
import { ClaimOwnershipError, FenceNotFoundError } from "./fence-ops";
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

type ProjectErrorConstructor =
  | typeof FenceError
  | typeof ClaimOwnershipError
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
  | typeof EntityNotFoundError;

export type ProjectErrorResponse = {
  errorClass: ProjectErrorConstructor;
  status: number;
  code: string;
  extras?: (err: Error) => Record<string, unknown>;
};

export const projectErrorResponses: ProjectErrorResponse[] = [
  { errorClass: FenceError, status: 409, code: "stale-fence" },
  {
    errorClass: ClaimOwnershipError,
    status: 403,
    code: "release-ownership-denied",
  },
  { errorClass: GateNotFoundError, status: 404, code: "not-found" },
  {
    errorClass: GateAlreadySettledError,
    status: 409,
    code: "gate-already-settled",
  },
  { errorClass: FenceNotFoundError, status: 400, code: "no-fence" },
  {
    errorClass: GateFenceError,
    status: 409,
    code: "gate-fence-conflict",
  },
  {
    errorClass: GateBlockedError,
    status: 409,
    code: "gate-blocked",
    extras: (err) => ({ gateIds: (err as GateBlockedError).gateIds }),
  },
  { errorClass: RecordAlreadyExistsError, status: 409, code: "conflict" },
  { errorClass: RecordNotFoundError, status: 404, code: "not-found" },
  {
    errorClass: RecordInvalidStateError,
    status: 409,
    code: "invalid-state",
  },
  { errorClass: RevisionNotFoundError, status: 404, code: "not-found" },
  { errorClass: EntityAlreadyExistsError, status: 409, code: "already-exists" },
  { errorClass: EntityNotFoundError, status: 404, code: "not-found" },
];

export function mapProjectError(
  err: Error,
): { status: number; code: string; extras?: Record<string, unknown> } | null {
  for (const rule of projectErrorResponses) {
    if (err instanceof rule.errorClass) {
      return {
        status: rule.status,
        code: rule.code,
        extras: rule.extras?.(err),
      };
    }
  }
  return null;
}
