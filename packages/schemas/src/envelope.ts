import type { ErrorEnvelope } from "./api";

/**
 * Pure factory for an HTTP error-envelope body.
 *
 * Returns the typed `ErrorEnvelope` shape (`{ ok:false, error:{ code, message,
 * retryable, ...extras } }`). No Hono, no `Response` — callers are responsible
 * for serialising and setting the HTTP status code.
 *
 * @param code      Error code string (e.g. from `TILA_ERRORS`)
 * @param message   Human-readable error message
 * @param retryable Whether the client should retry the request
 * @param extras    Optional extra fields merged into the error object (e.g. `gateIds`)
 */
export function errorEnvelope(
  code: string,
  message: string,
  retryable: boolean,
  extras?: Record<string, unknown>,
): ErrorEnvelope {
  return {
    ok: false,
    error: {
      code,
      message,
      retryable,
      ...extras,
    },
  };
}

/**
 * Pure factory for an HTTP success-envelope body.
 *
 * Returns `{ ok:true, ...body }`. No Hono, no `Response` — callers are
 * responsible for serialising and setting the HTTP status code.
 *
 * @param body  The response payload to merge at the top level alongside `ok`
 */
export function okEnvelope<T extends Record<string, unknown>>(
  body: T,
): { ok: true } & T {
  return { ok: true, ...body };
}
