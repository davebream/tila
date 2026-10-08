import {
  D1ProjectRegistry,
  D1RateLimitStore,
  D1SessionStore,
  GitHubAppConfigStore,
  ProjectMembershipStore,
  RepoAllowlistStore,
} from "@tila/backend-d1";
import {
  type MembershipSource,
  type ProjectRole,
  type SessionPermission,
  roleToPermission,
} from "@tila/schemas";
import { Hono } from "hono";
import { z } from "zod";
import { COOKIE_SESSION_TTL_SECONDS } from "../config";
import { buildSessionCookie, isLocalhost } from "../lib/cookie-helpers";
import {
  checkUserMembership,
  getInstallationAccessToken,
  mintAppJwt,
} from "../lib/github-app";
import { hashToken } from "../lib/hash-token";
import {
  resolveGithubAdmission,
  resolveRepositoryAccess,
} from "../lib/repo-access-policy";
import { invalidateSession } from "../lib/session-cache";
import { principalIdFor } from "../middleware/request-identity";
import type {
  CookieSessionTokenResult,
  Env,
  HonoVariables,
  WorkspaceSessionTokenResult,
} from "../types";

type AppEnv = { Bindings: Env; Variables: HonoVariables };
export const workspace = new Hono<AppEnv>();

const WORKSPACE_DEADLINE_MS = 25_000;
const SELECT_RATE_LIMIT_MAX = 20;
const SELECT_RATE_LIMIT_WINDOW_MS = 60_000;
const PROJECT_SESSION_TTL_MS = COOKIE_SESSION_TTL_SECONDS * 1000;
const WorkspaceSelectRequestSchema = z.object({
  project_id: z.string().min(1).max(128),
});

function permissionToScope(permission: SessionPermission): string {
  return permission === "read" ? "read" : "full";
}

async function createSelectedSession(
  c: import("hono").Context<AppEnv>,
  wsSession: WorkspaceSessionTokenResult,
  projectId: string,
  role: ProjectRole,
  sources: MembershipSource[],
  sourceRepoId?: number,
): Promise<Response> {
  const sessionStore = new D1SessionStore(c.env.DB);
  try {
    await sessionStore.revoke(wsSession.sessionHash);
  } catch {
    // Non-fatal: proceed to create the project-scoped replacement.
  }
  invalidateSession(wsSession.sessionHash);

  const newSessionToken = crypto.randomUUID();
  const newSessionHash = await hashToken(newSessionToken, c.env.HASH_PEPPER);
  const expiresAt = Date.now() + PROJECT_SESSION_TTL_MS;
  const permission = roleToPermission(role);
  const scopes = permissionToScope(permission);
  await sessionStore.create({
    sessionHash: newSessionHash,
    projectId,
    tokenHash: "",
    actorName: wsSession.githubLogin,
    principalId: wsSession.principalId ?? "",
    scopes,
    permission,
    role,
    membershipSource: JSON.stringify(sources),
    sourceRepoId,
    expiresAt,
    // Selecting a project replaces the session row; the authentication event
    // itself is unchanged, so the step-up clock must not restart here.
    authenticatedAt: wsSession.authenticatedAt,
  });

  return new Response(
    JSON.stringify({
      ok: true,
      projectId,
      scopes,
      role,
      membership_sources: sources,
    }),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Set-Cookie": buildSessionCookie(
          newSessionToken,
          isLocalhost(c.req.url),
        ),
      },
    },
  );
}

async function workspaceAccess(env: Env, projectId: string, login: string) {
  if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY) return null;
  const installation = await new GitHubAppConfigStore(env.DB).getInstallation(
    projectId,
  );
  if (!installation) return null;
  const appJwt = await mintAppJwt(
    Number(env.GITHUB_APP_ID),
    env.GITHUB_APP_PRIVATE_KEY,
  );
  const installationToken = await getInstallationAccessToken(
    appJwt,
    installation.installation_id,
  );
  const repos = await new RepoAllowlistStore(env.DB).listForProject(projectId);
  return resolveRepositoryAccess(repos, (repo) =>
    checkUserMembership(
      installationToken,
      repo.github_owner,
      repo.github_repo,
      login,
    ),
  );
}

workspace.get("/projects", async (c) => {
  const token = c.get("tokenResult");
  const principalId = principalIdFor(token);
  const login =
    token.kind === "workspace-session" ? token.githubLogin : token.name;
  const registry = new D1ProjectRegistry(c.env.DB);
  const explicit = await new ProjectMembershipStore(
    c.env.DB,
  ).listProjectsForPrincipal(principalId);
  const accessible = new Map<
    string,
    {
      projectId: string;
      displayName: string;
      role?: ProjectRole;
      repos: { owner: string; repo: string; permission: string }[];
    }
  >(explicit.map((project) => [project.projectId, { ...project, repos: [] }]));
  // Project credentials enumerate only their own project.
  if (token.kind !== "workspace-session") {
    const { resolveTokenMembership } = await import("../middleware/membership");
    const membership = await resolveTokenMembership(
      c.env.DB,
      token,
      token.projectId,
    );
    const meta = membership ? await registry.get(token.projectId) : null;
    return c.json({
      ok: true,
      projects:
        meta && membership
          ? [
              {
                projectId: token.projectId,
                displayName: meta.displayName ?? token.projectId,
                role: membership.role,
                repos: [],
              },
            ]
          : [],
    });
  }
  if (c.env.GITHUB_APP_ID && c.env.GITHUB_APP_PRIVATE_KEY) {
    const start = Date.now();
    for (const project of await registry.listAll()) {
      if (Date.now() - start > WORKSPACE_DEADLINE_MS) break;
      try {
        const { membership, access } = await resolveGithubAdmission(
          c.env.DB,
          project.projectId,
          principalId,
          () => workspaceAccess(c.env, project.projectId, login),
        );
        if (!membership) continue;
        const meta = await registry.get(project.projectId);
        if (!meta) continue;
        accessible.set(project.projectId, {
          projectId: project.projectId,
          displayName: meta.displayName ?? project.projectId,
          role: membership.role,
          repos: access
            ? [
                {
                  owner: access.repo.github_owner,
                  repo: access.repo.github_repo,
                  permission: access.permission,
                },
              ]
            : [],
        });
      } catch {
        /* Unavailable mirrored access never establishes admission. */
      }
    }
  }
  return c.json({
    ok: true,
    projects: [...accessible.values()].sort((a, b) =>
      a.projectId.localeCompare(b.projectId),
    ),
  });
});

workspace.post("/select", async (c) => {
  // Rate limit: keyed by IP
  const ip = c.req.raw.headers.get("CF-Connecting-IP");
  if (ip) {
    const rateLimitStore = new D1RateLimitStore(c.env.DB);
    try {
      const isLimited = await rateLimitStore.check(
        `workspace-select:${ip}`,
        SELECT_RATE_LIMIT_MAX,
        SELECT_RATE_LIMIT_WINDOW_MS,
      );
      if (isLimited) {
        return c.json(
          {
            ok: false,
            error: {
              code: "rate-limited",
              message: "Too many project select attempts",
              retryable: true,
            },
          },
          429,
        );
      }
    } catch {
      // Fail open on D1 error
    }
  }

  // Require workspace-session token kind
  const tokenResult = c.get("tokenResult");
  if (tokenResult.kind !== "workspace-session") {
    return c.json(
      {
        ok: false,
        error: {
          code: "invalid-session",
          message: "This endpoint requires a workspace session",
          retryable: false,
        },
      },
      400,
    );
  }

  const wsSession = tokenResult as WorkspaceSessionTokenResult;
  if (!wsSession.principalId) {
    return c.json(
      {
        ok: false,
        error: {
          code: "session-expired",
          message:
            "Session predates canonical identity support; sign in again.",
          retryable: false,
        },
      },
      401,
    );
  }

  // Parse body
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json(
      {
        ok: false,
        error: {
          code: "validation-error",
          message: "Invalid JSON body",
          retryable: false,
        },
      },
      400,
    );
  }

  const parsed = WorkspaceSelectRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      {
        ok: false,
        error: {
          code: "validation-error",
          message: "Invalid project_id",
          retryable: false,
        },
      },
      400,
    );
  }

  const { project_id: projectId } = parsed.data;

  try {
    const { membership, access } = await resolveGithubAdmission(
      c.env.DB,
      projectId,
      wsSession.principalId,
      () => workspaceAccess(c.env, projectId, wsSession.githubLogin),
      true,
    );
    if (!membership)
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
    return createSelectedSession(
      c,
      wsSession,
      projectId,
      membership.role,
      membership.sources,
      access?.repo.github_repo_id,
    );
  } catch {
    return c.json(
      {
        ok: false,
        error: {
          code: "membership-unavailable",
          message: "Project membership temporarily unavailable",
          retryable: true,
        },
      },
      503,
    );
  }
});

const WORKSPACE_SESSION_TTL_MS = 8 * 60 * 60 * 1000;

workspace.post("/deselect", async (c) => {
  const tokenResult = c.get("tokenResult");
  if (tokenResult.kind !== "cookie-session") {
    return c.json(
      {
        ok: false,
        error: {
          code: "invalid-session",
          message: "This endpoint requires a project session",
          retryable: false,
        },
      },
      400,
    );
  }

  const session = tokenResult as CookieSessionTokenResult;
  if (!session.principalId) {
    return c.json(
      {
        ok: false,
        error: {
          code: "session-expired",
          message:
            "Session predates canonical identity support; sign in again.",
          retryable: false,
        },
      },
      401,
    );
  }
  const sessionStore = new D1SessionStore(c.env.DB);

  try {
    await sessionStore.revoke(session.sessionHash);
  } catch {
    // Non-fatal
  }
  invalidateSession(session.sessionHash);

  const newSessionToken = crypto.randomUUID();
  const newSessionHash = await hashToken(newSessionToken, c.env.HASH_PEPPER);
  const expiresAt = Date.now() + WORKSPACE_SESSION_TTL_MS;

  await sessionStore.create({
    sessionHash: newSessionHash,
    projectId: "",
    tokenHash: "",
    actorName: session.name,
    principalId: session.principalId,
    scopes: "",
    permission: "read",
    expiresAt,
    authenticatedAt: session.authenticatedAt,
  });

  const localDev = isLocalhost(c.req.url);
  const cookie = buildSessionCookie(newSessionToken, localDev);

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": cookie,
    },
  });
});
