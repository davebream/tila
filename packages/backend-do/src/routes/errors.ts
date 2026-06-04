import { FenceError } from "@tila/core";
import {
  EntityAlreadyExistsError,
  EntityNotFoundError,
  FenceNotFoundError,
  GateAlreadySettledError,
  GateBlockedError,
  GateFenceError,
  GateNotFoundError,
  RecordAlreadyExistsError,
  RecordInvalidStateError,
  RecordNotFoundError,
  RevisionNotFoundError,
} from "@tila/ops-sqlite";
import type { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { ZodError } from "zod";
import { formatZodIssues, jsonError } from "./responses";

type ProjectErrorConstructor =
  | typeof FenceError
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

type ErrorResponseRule = {
  errorClass: ProjectErrorConstructor;
  status: ContentfulStatusCode;
  code: string;
  extras?: (err: Error) => Record<string, unknown>;
};

const projectErrorResponses: ErrorResponseRule[] = [
  { errorClass: FenceError, status: 409, code: "stale-fence" },
  { errorClass: GateNotFoundError, status: 404, code: "not-found" },
  {
    errorClass: GateAlreadySettledError,
    status: 409,
    code: "gate-already-settled",
  },
  { errorClass: FenceNotFoundError, status: 400, code: "no-fence" },
  { errorClass: GateFenceError, status: 409, code: "no-fence" },
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

export function installProjectErrorHandlers(app: Hono): void {
  app.onError((err, c) => {
    if (err instanceof ZodError) {
      return jsonError(c, 400, "validation-error", formatZodIssues(err.issues));
    }

    for (const rule of projectErrorResponses) {
      if (err instanceof rule.errorClass) {
        return jsonError(
          c,
          rule.status,
          rule.code,
          err.message,
          rule.extras?.(err),
        );
      }
    }

    console.error("ProjectDO unhandled error:", err);
    return c.json(
      {
        ok: false,
        error: {
          code: "internal",
          message: "Internal server error",
          retryable: true,
        },
      },
      500,
    );
  });

  app.notFound((c) => {
    return jsonError(
      c,
      404,
      "not-found",
      `Unknown route: ${c.req.method} ${new URL(c.req.url).pathname}`,
    );
  });
}
