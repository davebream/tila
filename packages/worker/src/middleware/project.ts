import type { MiddlewareHandler } from "hono";
import type { Env, HonoVariables } from "../types";

export const projectMiddleware: MiddlewareHandler<{
  Bindings: Env;
  Variables: HonoVariables;
}> = async (c, next) => {
  const projectId = c.req.param("projectId");
  if (!projectId) {
    return c.json(
      {
        ok: false,
        error: {
          code: "not-found",
          message: "Missing projectId",
          retryable: false,
        },
      },
      404,
    );
  }

  const doId = c.env.PROJECT.idFromName(projectId);
  const stub = c.env.PROJECT.get(doId);

  c.set("projectId", projectId);
  c.set("doStub", stub);

  // Guard: token's projectId must match route projectId
  const tokenResult = c.get("tokenResult");
  if (tokenResult.projectId !== projectId) {
    return c.json(
      {
        ok: false,
        error: {
          code: "project-mismatch",
          message: "Token is not authorized for this project",
          retryable: false,
        },
      },
      403,
    );
  }

  return next();
};
