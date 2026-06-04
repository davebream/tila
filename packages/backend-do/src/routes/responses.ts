import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export function jsonError(
  c: Context,
  status: ContentfulStatusCode,
  code: string,
  message: string,
  extras?: Record<string, unknown>,
) {
  return c.json(
    {
      ok: false,
      error: {
        code,
        message,
        retryable: false,
        ...extras,
      },
    },
    status,
  );
}

export function formatZodIssues(
  issues: ReadonlyArray<{
    path: readonly (string | number)[];
    message: string;
  }>,
): string {
  return issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
}
