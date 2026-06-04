import type { MiddlewareHandler } from "hono";
import type { Env, HonoVariables } from "../types";

type AppEnv = { Bindings: Env; Variables: HonoVariables };

export const requestIdMiddleware: MiddlewareHandler<AppEnv> = async (
  c,
  next,
) => {
  const id = c.req.header("X-Request-ID") ?? crypto.randomUUID();
  c.set("requestId", id);
  await next();
  c.header("X-Request-ID", id);
};
