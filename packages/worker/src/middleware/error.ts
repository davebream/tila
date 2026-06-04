import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { ZodError } from "zod";

export function errorHandler(err: Error, c: Context): Response {
  if (err instanceof ZodError) {
    const message = err.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    return c.json(
      {
        ok: false,
        error: { code: "validation-error", message, retryable: false },
      },
      400,
    );
  }

  if (err instanceof HTTPException) {
    return err.getResponse();
  }

  // A malformed (or empty) JSON request body makes Hono's c.req.json() run
  // JSON.parse(text), which throws a native SyntaxError. This branch intentionally
  // maps ALL SyntaxErrors to a 400 client error: in this Worker, the only SyntaxError
  // that reaches the global handler originates from request-body parsing (TOML parsing
  // throws TomlError, core schema parsing throws SchemaParseException, and in-request
  // JSON.parse sites are locally try/caught).
  if (err instanceof SyntaxError) {
    return c.json(
      {
        ok: false,
        error: {
          code: "validation-error",
          message: "Malformed JSON in request body",
          retryable: false,
        },
      },
      400,
    );
  }

  console.error("Unhandled error:", err);
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
}
