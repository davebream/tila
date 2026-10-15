import { FenceError } from "@tila/core";
import {
  CredentialPolicyDenied,
  JournalReportError,
  mapProjectError,
} from "@tila/ops-sqlite";
import { errorEnvelope } from "@tila/schemas";
import type { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { ZodError } from "zod";
import { formatZodIssues, jsonError } from "./responses";
import { CORRELATION_ID_KEY, WITHHOLD_RECORD_DETAIL_KEY } from "./types";

export function installProjectErrorHandlers(app: Hono): void {
  app.onError((err, c) => {
    if (err instanceof JournalReportError) {
      if (err.retryAfter !== undefined)
        c.header("Retry-After", String(err.retryAfter));
      return jsonError(
        c,
        err.status as ContentfulStatusCode,
        err.code,
        err.message,
        undefined,
        err.status === 429,
      );
    }
    if (err instanceof CredentialPolicyDenied)
      return jsonError(c, 403, "permission-denied", err.message);
    if (err instanceof ZodError) {
      return jsonError(c, 400, "validation-error", formatZodIssues(err.issues));
    }

    if (err instanceof Error) {
      const mapped = mapProjectError(err);
      if (mapped) {
        // A stale fence names the fence currently held. A record write from a
        // credential that may not read the record is told only that it is stale.
        const withholds = (c.get as (k: string) => boolean | undefined)(
          WITHHOLD_RECORD_DETAIL_KEY,
        );
        return jsonError(
          c,
          mapped.status as ContentfulStatusCode,
          mapped.code,
          withholds && err instanceof FenceError
            ? "Fence mismatch"
            : err.message,
          mapped.extras,
          mapped.retryable,
        );
      }
    }

    const correlationId =
      (c.get as (k: string) => string | undefined)(CORRELATION_ID_KEY) ?? "";
    console.error(
      "ProjectDO unhandled error:",
      err,
      ...(correlationId ? ["requestId:", correlationId] : []),
    );
    return c.json(
      errorEnvelope("internal", "Internal server error", true),
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
