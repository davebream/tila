import { FenceError } from "@tila/core";
import { mapProjectError } from "@tila/ops-sqlite";
import { errorEnvelope } from "@tila/schemas";
import type { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { ZodError } from "zod";
import { formatZodIssues, jsonError } from "./responses";
import { CORRELATION_ID_KEY } from "./types";

export function installProjectErrorHandlers(app: Hono): void {
  app.onError((err, c) => {
    if (err instanceof ZodError) {
      return jsonError(c, 400, "validation-error", formatZodIssues(err.issues));
    }

    if (err instanceof Error) {
      const mapped = mapProjectError(err);
      if (mapped) {
        return jsonError(
          c,
          mapped.status as ContentfulStatusCode,
          mapped.code,
          err.message,
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
