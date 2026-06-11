import { FenceError } from "@tila/core";
import { mapProjectError } from "@tila/ops-sqlite";
import type { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { ZodError } from "zod";
import { formatZodIssues, jsonError } from "./responses";

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
