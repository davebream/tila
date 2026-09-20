import { PROJECT_ROLE_RANK } from "@tila/schemas";
import type { MiddlewareHandler } from "hono";
import type { Env, HonoVariables } from "../types";
import { resolveTokenMembership } from "./membership";

type AppEnv = { Bindings: Env; Variables: HonoVariables };

function denied(c: Parameters<MiddlewareHandler<AppEnv>>[0]) {
  return c.json(
    {
      ok: false,
      error: {
        code: "permission-denied",
        message: "Project owner required",
        retryable: false,
      },
    },
    403,
  );
}

export const requireProjectOwner: MiddlewareHandler<AppEnv> = async (
  c,
  next,
) => {
  const token = c.get("tokenResult");
  if (token.kind === "d1-token" && token.scopes === "full") return next();
  const role = c.get("effectiveRole");
  return role && PROJECT_ROLE_RANK[role] >= PROJECT_ROLE_RANK.owner
    ? next()
    : denied(c);
};

export async function requireProjectOwnerHttp(
  c: import("hono").Context<AppEnv>,
): Promise<Response | null> {
  const token = c.get("tokenResult");
  if (token.kind === "d1-token" && token.scopes === "full") return null;
  try {
    const membership = await resolveTokenMembership(
      c.env.DB,
      token,
      token.projectId,
    );
    if (membership?.role === "owner") return null;
  } catch {
    return c.json(
      {
        ok: false,
        error: {
          code: "membership-unavailable",
          message: "Project membership is temporarily unavailable",
          retryable: true,
        },
      },
      503,
    );
  }
  return denied(c);
}
