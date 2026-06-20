import {
  D1ProjectRegistry,
  D1RateLimitStore,
  D1SessionStore,
  GitHubAppConfigStore,
  RepoAllowlistStore,
} from "@tila/backend-d1";
import { Hono } from "hono";
import { z } from "zod";
import { COOKIE_SESSION_TTL_SECONDS } from "../config";
import { buildSessionCookie, isLocalhost } from "../lib/cookie-helpers";
import {
  checkUserMembership,
  getInstallationAccessToken,
  mintAppJwt,
} from "../lib/github-app";
import {
  PERMISSION_HIERARCHY,
  normalizeGitHubPermission,
} from "../lib/github-permission";
import { hashToken } from "../lib/hash-token";
import { invalidateSession } from "../lib/session-cache";
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

function permissionToScope(perm: string): string {
  return (PERMISSION_HIERARCHY[perm] ?? 0) >= PERMISSION_HIERARCHY.write
    ? "full"
    : "read";
}

workspace.get("/projects", async (c) => {
  const tokenResult = c.get("tokenResult");
  const githubLogin =
    tokenResult.kind === "workspace-session"
      ? (tokenResult as WorkspaceSessionTokenResult).githubLogin
      : tokenResult.name;

  const registry = new D1ProjectRegistry(c.env.DB);

  if (!c.env.GITHUB_APP_ID || !c.env.GITHUB_APP_PRIVATE_KEY) {
    // SEC-4: With the GitHub App unconfigured there is no way to resolve
    // per-user repository membership, so we cannot enumerate the registry
    // without leaking every project ID on the instance. Scope the response to
    // exactly what the caller is already entitled to: the token-scoped project
    // (D1/bootstrap token or bearer session that carries a projectId), or an
    // empty list for a workspace session (projectId "") that has not selected
    // a project yet.
    const scopedProjectId = tokenResult.projectId;
    if (!scopedProjectId) {
      return c.json({ ok: true, projects: [] });
    }
    const meta = await registry.get(scopedProjectId);
    return c.json({
      ok: true,
      projects: [
        {
          projectId: scopedProjectId,
          displayName: meta?.displayName ?? scopedProjectId,
          repos: [],
        },
      ],
    });
  }

  const allProjects = await registry.listAll();
  const configStore = new GitHubAppConfigStore(c.env.DB);
  const allowlistStore = new RepoAllowlistStore(c.env.DB);

  const appJwt = await mintAppJwt(
    Number(c.env.GITHUB_APP_ID),
    c.env.GITHUB_APP_PRIVATE_KEY,
  );
  const startTime = Date.now();

  const accessible = [];
  for (const { projectId } of allProjects) {
    if (Date.now() - startTime > WORKSPACE_DEADLINE_MS) break;

    const installation = await configStore.getInstallation(projectId);
    if (!installation) continue;

    const allowedRepos = await allowlistStore.listForProject(projectId);
    if (allowedRepos.length === 0) continue;

    try {
      const installationToken = await getInstallationAccessToken(
        appJwt,
        installation.installation_id,
      );

      const userRepos = [];
      for (const repo of allowedRepos) {
        if (Date.now() - startTime > WORKSPACE_DEADLINE_MS) break;
        const perm = await checkUserMembership(
          installationToken,
          repo.github_owner,
          repo.github_repo,
          githubLogin,
        );
        if (perm && perm !== "none") {
          userRepos.push({
            owner: repo.github_owner,
            repo: repo.github_repo,
            permission: perm,
          });
        }
      }

      if (userRepos.length > 0) {
        const meta = await registry.get(projectId);
        accessible.push({
          projectId,
          displayName: meta?.displayName ?? projectId,
          repos: userRepos,
        });
      }
    } catch (err) {
      console.warn(`[workspace] skipping project ${projectId}:`, err);
    }
  }

  return c.json({ ok: true, projects: accessible });
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

  // Check GitHub App config
  if (!c.env.GITHUB_APP_ID || !c.env.GITHUB_APP_PRIVATE_KEY) {
    return c.json(
      {
        ok: false,
        error: {
          code: "not-configured",
          message: "GitHub App not configured",
          retryable: false,
        },
      },
      500,
    );
  }

  // Load installation config for the project
  const configStore = new GitHubAppConfigStore(c.env.DB);
  const installation = await configStore.getInstallation(projectId);
  if (!installation) {
    return c.json(
      {
        ok: false,
        error: {
          code: "not-found",
          message: "Project not found or GitHub App not installed",
          retryable: false,
        },
      },
      404,
    );
  }

  // Get installation access token
  let installationToken: string;
  try {
    const appJwt = await mintAppJwt(
      Number(c.env.GITHUB_APP_ID),
      c.env.GITHUB_APP_PRIVATE_KEY,
    );
    installationToken = await getInstallationAccessToken(
      appJwt,
      installation.installation_id,
    );
  } catch (err) {
    console.error("[workspace/select] Failed to get installation token:", err);
    return c.json(
      {
        ok: false,
        error: {
          code: "github-api-error",
          message: "Failed to obtain GitHub App installation token",
          retryable: true,
        },
      },
      502,
    );
  }

  // Filter against _project_repos allowlist
  const allowlistStore = new RepoAllowlistStore(c.env.DB);
  const allowedRepos = await allowlistStore.listForProject(projectId);

  const login = wsSession.githubLogin;
  let bestPermission = "none";

  for (const repo of allowedRepos) {
    const perm = await checkUserMembership(
      installationToken,
      repo.github_owner,
      repo.github_repo,
      login,
    );
    if (
      perm &&
      (PERMISSION_HIERARCHY[perm] ?? 0) >
        (PERMISSION_HIERARCHY[bestPermission] ?? 0)
    ) {
      bestPermission = perm;
    }
  }

  if (bestPermission === "none" || allowedRepos.length === 0) {
    return c.json(
      {
        ok: false,
        error: {
          code: "forbidden",
          message: "Insufficient repository permissions for this project",
          retryable: false,
        },
      },
      403,
    );
  }

  // Revoke workspace session and evict from cache
  const sessionStore = new D1SessionStore(c.env.DB);
  try {
    await sessionStore.revoke(wsSession.sessionHash);
  } catch {
    // Non-fatal: proceed to create new session
  }
  invalidateSession(wsSession.sessionHash);

  // Create project-scoped session
  const newSessionToken = crypto.randomUUID();
  const newSessionHash = await hashToken(newSessionToken, c.env.HASH_PEPPER);
  const expiresAt = Date.now() + PROJECT_SESSION_TTL_MS;
  const scopes = permissionToScope(bestPermission);

  const permission = normalizeGitHubPermission(bestPermission);
  await sessionStore.create({
    sessionHash: newSessionHash,
    projectId,
    tokenHash: "",
    actorName: login,
    scopes,
    permission,
    expiresAt,
  });

  // Build session cookie
  const localDev = isLocalhost(c.req.url);
  const cookie = buildSessionCookie(newSessionToken, localDev);

  return new Response(JSON.stringify({ ok: true, projectId, scopes }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": cookie,
    },
  });
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
    scopes: "",
    permission: "read",
    expiresAt,
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
