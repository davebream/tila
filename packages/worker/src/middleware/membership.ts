import {
  type MirroredMembershipCandidate,
  ProjectMembershipStore,
  RepoAllowlistStore,
} from "@tila/backend-d1";
import {
  type MembershipSource,
  PROJECT_ROLE_RANK,
  type ProjectRole,
} from "@tila/schemas";
import type { MiddlewareHandler } from "hono";
import type { Env, HonoVariables, UnifiedTokenResult } from "../types";
import { principalIdFor } from "./request-identity";

const PERMISSION_ROLE: Record<string, Exclude<ProjectRole, "owner">> = {
  read: "viewer",
  write: "participant",
  admin: "maintainer",
};

function cappedRole(
  permission: string,
  cap: string,
): Exclude<ProjectRole, "owner"> | null {
  const role = PERMISSION_ROLE[permission];
  const parsedCap =
    PERMISSION_ROLE[
      cap === "viewer" ? "read" : cap === "participant" ? "write" : "admin"
    ];
  if (!role || !parsedCap) return null;
  return PROJECT_ROLE_RANK[role] <= PROJECT_ROLE_RANK[parsedCap]
    ? role
    : parsedCap;
}

export async function mirroredCandidateForToken(
  db: D1Database,
  token: UnifiedTokenResult,
): Promise<MirroredMembershipCandidate | null> {
  if (token.kind !== "session" && token.kind !== "cookie-session") return null;
  const repoId =
    token.kind === "session" ? token.githubRepoId : token.sourceRepoId;
  if (!repoId) return null;
  const result = await new RepoAllowlistStore(db).getAccessPolicy(
    token.projectId,
    "github.com",
    repoId,
  );
  if (result.status !== "ok" || !result.policy.membership_enabled) return null;
  const role = cappedRole(token.permission, result.policy.membership_role_cap);
  return role ? { role, githubRepoId: repoId } : null;
}

export async function resolveTokenMembership(
  db: D1Database,
  token: UnifiedTokenResult,
  projectId: string,
): Promise<{
  role: ProjectRole;
  sources: MembershipSource[];
  mirroredRepoId?: number;
} | null> {
  if (token.kind === "d1-token") {
    return token.scopes === "full"
      ? { role: "owner", sources: ["bootstrap"] }
      : { role: "viewer", sources: ["bootstrap"] };
  }
  const principalId = principalIdFor(token);
  const mirrored = await mirroredCandidateForToken(db, token);
  return new ProjectMembershipStore(db).resolve(
    projectId,
    principalId,
    mirrored,
  );
}

export function projectMembershipMiddleware(): MiddlewareHandler<{
  Bindings: Env;
  Variables: HonoVariables;
}> {
  return async (c, next) => {
    const projectId = c.get("projectId");
    try {
      const membership = await resolveTokenMembership(
        c.env.DB,
        c.get("tokenResult"),
        projectId,
      );
      if (!membership) {
        return c.json(
          {
            ok: false,
            error: {
              code: "membership-required",
              message: "Principal is not a member of this project",
              retryable: false,
            },
          },
          403,
        );
      }
      c.set("effectiveRole", membership.role);
      c.set("membershipSources", membership.sources);
      c.set("membershipRepoId", membership.mirroredRepoId);
      return next();
    } catch (error) {
      console.error(
        JSON.stringify({
          message: "project membership resolution failed",
          projectId,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
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
  };
}
