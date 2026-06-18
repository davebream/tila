import { errorEnvelope } from "@tila/schemas";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { ZodError } from "zod";
import { emitUnhandledErrorDatapoint } from "../lib/analytics";

export function errorHandler(err: Error, c: Context): Response {
  if (err instanceof ZodError) {
    const message = err.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    return c.json(errorEnvelope("validation-error", message, false), 400);
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
      errorEnvelope(
        "validation-error",
        "Malformed JSON in request body",
        false,
      ),
      400,
    );
  }

  console.error("Unhandled error:", err);
  // Fire-and-forget distinct datapoint for unhandled 500s — never throws
  try {
    if (c.env?.ANALYTICS) {
      emitUnhandledErrorDatapoint(c.env.ANALYTICS, c.executionCtx, {
        route: c.req.routePath ?? c.req.path,
        errorName: err instanceof Error ? err.name : "UnknownError",
      });
    }
  } catch {
    // Swallow — emission is never load-bearing
  }
  return c.json(errorEnvelope("internal", "Internal server error", true), 500);
}
