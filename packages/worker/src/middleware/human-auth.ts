import { roleToPermission } from "@tila/schemas";
import type { Context } from "hono";
import { D1RevokedSubjectsStore, ProjectMembershipStore } from "../d1";
import {
  HUMAN_BEARER_PREFIX,
  currentHuman,
  hasHumanCredential,
} from "../lib/human-auth";
import type { Env, HonoVariables } from "../types";

export async function authenticateHuman(
  c: Context<{ Bindings: Env; Variables: HonoVariables }>,
): Promise<"absent" | "valid" | Response> {
  if (!hasHumanCredential(c.req.raw.headers)) return "absent";
  const current = await currentHuman(c);
  if (!current)
    return c.json(
      {
        ok: false,
        error: {
          code: "unauthorized",
          message: "Sign in again",
          retryable: false,
        },
      },
      401,
    );
  c.set("humanSession", current);
  const pathProject = c.req.path.match(/^\/projects\/([^/]+)/)?.[1];
  const projectId = pathProject
    ? decodeURIComponent(pathProject)
    : current.session.projectId;
  const principalId = `user:${current.user.id}`;
  const membership = projectId
    ? await new ProjectMembershipStore(c.env.DB).resolve(projectId, principalId)
    : null;
  if (membership) {
    const cutoff = await new D1RevokedSubjectsStore(c.env.DB).getRevokedBefore(
      projectId,
      "tila",
      current.user.id,
    );
    if (cutoff && (current.session.authenticatedAt ?? 0) < cutoff)
      return c.json(
        {
          ok: false,
          error: {
            code: "unauthorized",
            message: "Project sessions revoked; sign in again",
            retryable: false,
          },
        },
        401,
      );
  }
  if (pathProject && !membership)
    return c.json(
      {
        ok: false,
        error: {
          code: "forbidden",
          message: "Project access denied",
          retryable: false,
        },
      },
      403,
    );
  const common = {
    projectId: membership ? projectId : "",
    name: current.user.name,
    tokenId: "",
    sessionHash: current.session.id,
    expiresAt: current.session.expiresAt.getTime(),
    principalId,
    authenticatedAt: current.session.authenticatedAt ?? undefined,
  };
  c.set(
    "tokenResult",
    membership
      ? {
          ...common,
          kind: "cookie-session",
          scopes: "full",
          permission: roleToPermission(membership.role),
          role: membership.role,
          membershipSources: membership.sources,
          authMethod: "email",
        }
      : {
          ...common,
          kind: "workspace-session",
          scopes: "",
          githubLogin: current.user.name,
        },
  );
  c.set(
    "authKind",
    c.req.header("Authorization")?.startsWith(`Bearer ${HUMAN_BEARER_PREFIX}`)
      ? "bearer"
      : "cookie",
  );
  return "valid";
}
