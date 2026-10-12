import { RuntimeViewQuerySchema } from "@tila/schemas";
import { Hono } from "hono";
import { RuntimeViewCursorError, loadRuntimeView } from "../lib/runtime-view";
import { zodValidationError } from "../lib/validation";
import type { Env, HonoVariables } from "../types";

/** Read-only runtime projection: agents, bindings, runs, hosts, sessions. */
export const runtimeView = new Hono<{
  Bindings: Env;
  Variables: HonoVariables;
}>();
runtimeView.get("/", async (c) => {
  const parsed = RuntimeViewQuerySchema.safeParse(c.req.query());
  if (!parsed.success) return zodValidationError(c, parsed.error);
  try {
    return await loadRuntimeView(c, parsed.data);
  } catch (error) {
    if (error instanceof RuntimeViewCursorError)
      return c.json(
        {
          ok: false,
          error: {
            code: "validation-error",
            message: error.message,
            retryable: false,
          },
        },
        400,
      );
    throw error;
  }
});
