import type { Context } from "hono";
import type { ZodError } from "zod";

export function zodValidationError(
  c: Context,
  error: ZodError,
  code = "validation-error",
): Response {
  return c.json(
    {
      ok: false,
      error: {
        code,
        message: error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; "),
        retryable: false,
      },
    },
    400,
  );
}
