import { GitHubAppConfigStore, RepoAllowlistStore } from "@tila/backend-d1";
import { RepoRegisterRequestSchema } from "@tila/schemas";
import { Hono } from "hono";
import { getInstallationAccessToken, mintAppJwt } from "../lib/github-app";
import { getRepoMetadata } from "../lib/github-client";
import { zodValidationError } from "../lib/validation";
import type { Env, HonoVariables } from "../types";

type AppEnv = { Bindings: Env; Variables: HonoVariables };

export const repos = new Hono<AppEnv>();

/**
 * Scope guard for repo management routes.
 * Replicates requireTokenAdmin from tokens.ts verbatim.
 * Returns a 403 Response if the caller lacks full scope, or null if authorized.
 */
function requireTokenAdmin(c: import("hono").Context<AppEnv>): Response | null {
  const { scopes } = c.get("tokenResult");
  if (scopes !== "full") {
    return c.json(
      {
        ok: false,
        error: {
          code: "TOKEN_AUTHZ_DENIED",
          message: "Repo management requires full scope",
          retryable: false,
        },
      },
      403,
    );
  }
  return null;
}

// POST /api/repos -- Register a GitHub repo in the allowlist
repos.post("/", async (c) => {
  const authz = requireTokenAdmin(c);
  if (authz) return authz;
  const tokenResult = c.get("tokenResult");
  const projectId = tokenResult.projectId;

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json(
      {
        ok: false,
        error: {
          code: "VALIDATION_ERROR",
          message: "Invalid JSON body",
          retryable: false,
        },
      },
      400,
    );
  }

  const parsed = RepoRegisterRequestSchema.safeParse(body);
  if (!parsed.success)
    return zodValidationError(c, parsed.error, "VALIDATION_ERROR");

  const {
    owner,
    repo,
    github_host,
    github_token,
    min_read_permission,
    min_write_permission,
  } = parsed.data;

  // Resolve repo_id from GitHub API (Worker is sole authority — never trust client-supplied repo_id)
  const apiBase =
    github_host === "github.com"
      ? "https://api.github.com"
      : `https://${github_host}/api/v3`;

  // Use client-supplied token, or fall back to GitHub App installation token
  let resolvedToken = github_token ?? "";
  if (!resolvedToken && c.env.GITHUB_APP_ID && c.env.GITHUB_APP_PRIVATE_KEY) {
    const configStore = new GitHubAppConfigStore(c.env.DB);
    const installation = await configStore.getInstallation(projectId);
    if (installation) {
      try {
        const appJwt = await mintAppJwt(
          Number(c.env.GITHUB_APP_ID),
          c.env.GITHUB_APP_PRIVATE_KEY,
        );
        resolvedToken = await getInstallationAccessToken(
          appJwt,
          installation.installation_id,
          apiBase,
        );
      } catch (err) {
        console.warn(
          `[repos] Installation token failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  const result = await getRepoMetadata(resolvedToken, owner, repo, apiBase);

  if (!result.ok) {
    if (result.status === 404) {
      return c.json(
        {
          ok: false,
          error: {
            code: "REPO_NOT_FOUND",
            message: `GitHub repo ${owner}/${repo} not found`,
            retryable: false,
          },
        },
        404,
      );
    }
    if (result.status === 403) {
      return c.json(
        {
          ok: false,
          error: {
            code: "REPO_ACCESS_DENIED",
            message: `Access denied to GitHub repo ${owner}/${repo}`,
            retryable: false,
          },
        },
        403,
      );
    }
    if (result.status === 504) {
      return c.json(
        {
          ok: false,
          error: {
            code: "GITHUB_API_TIMEOUT",
            message: "GitHub API request timed out",
            retryable: true,
          },
        },
        504,
      );
    }
    return c.json(
      {
        ok: false,
        error: {
          code: "GITHUB_API_ERROR",
          message: `GitHub API returned ${result.status}`,
          retryable: true,
        },
      },
      502,
    );
  }

  // result.ok is true here — id and full_name are guaranteed defined
  const githubRepoId = result.id ?? 0;
  const fullName = result.full_name ?? `${owner}/${repo}`;

  const store = new RepoAllowlistStore(c.env.DB);
  await store.register({
    projectId,
    githubHost: github_host,
    githubOwner: owner,
    githubRepo: repo,
    githubRepoId,
    minReadPermission: min_read_permission,
    minWritePermission: min_write_permission,
    createdBy: tokenResult.name,
  });

  return c.json(
    {
      ok: true,
      github_repo_id: githubRepoId,
      full_name: fullName,
      registered_at: Math.floor(Date.now() / 1000),
    },
    201,
  );
});

// DELETE /api/repos/:repoId -- Remove a repo from the allowlist (idempotent)
repos.delete("/:repoId", async (c) => {
  const authz = requireTokenAdmin(c);
  if (authz) return authz;
  const tokenResult = c.get("tokenResult");
  const projectId = tokenResult.projectId;

  const repoIdStr = c.req.param("repoId");
  const repoId = Number.parseInt(repoIdStr, 10);
  if (Number.isNaN(repoId)) {
    return c.json(
      {
        ok: false,
        error: {
          code: "VALIDATION_ERROR",
          message: "repoId must be a numeric GitHub repo ID",
          retryable: false,
        },
      },
      400,
    );
  }

  const store = new RepoAllowlistStore(c.env.DB);
  await store.remove(projectId, "github.com", repoId);

  return c.json({
    ok: true,
    github_repo_id: repoId,
    removed_at: Math.floor(Date.now() / 1000),
  });
});
