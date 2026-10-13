import {
  RepoAccessPolicyRequestSchema,
  RepoOidcPolicyRequestSchema,
  RepoPolicyPreconditionSchema,
  RepoRegisterRequestSchema,
} from "@tila/schemas";
import { type Context, Hono } from "hono";
import { GitHubAppConfigStore, RepoAllowlistStore } from "../d1";
import { getInstallationAccessToken, mintAppJwt } from "../lib/github-app";
import { getRepoMetadata } from "../lib/github-client";
import { zodValidationError } from "../lib/validation";
import { requireFreshAuthentication } from "../middleware/protected-operation";
import { requireProjectOwnerHttp } from "../middleware/require-project-owner";
import type { Env, HonoVariables } from "../types";

type AppEnv = { Bindings: Env; Variables: HonoVariables };

export const repos = new Hono<AppEnv>();

function parseRepoId(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const repoId = Number(value);
  return Number.isSafeInteger(repoId) && repoId > 0 ? repoId : null;
}

/** Owner, then (for writes from a stale cookie session) fresh authentication. */
async function ownerWrite(c: Context<AppEnv>) {
  return (await requireProjectOwnerHttp(c)) ?? requireFreshAuthentication(c);
}

function failure(
  c: Context<AppEnv>,
  status: 400 | 404 | 409 | 412 | 500,
  code: string,
  message: string,
  extras: Record<string, unknown> = {},
) {
  return c.json(
    { ok: false, error: { code, message, retryable: false, ...extras } },
    status,
  );
}

/** Repository host from `?host=`; defaults to github.com. */
function hostOf(c: Context<AppEnv>): string | null {
  const host = (c.req.query("host") ?? "github.com").trim().toLowerCase();
  return /^[a-z0-9.-]{1,253}(?::\d{1,5})?$/.test(host) ? host : null;
}

function target(c: Context<AppEnv>) {
  const repoId = parseRepoId(c.req.param("repoId") ?? "");
  const host = hostOf(c);
  if (repoId === null)
    return failure(
      c,
      400,
      "validation-error",
      "repoId must be a positive integer",
    );
  if (host === null)
    return failure(c, 400, "validation-error", "host must be a hostname");
  return { repoId, host, projectId: c.get("tokenResult").projectId };
}

const notFound = (c: Context<AppEnv>) =>
  failure(c, 404, "repo-not-found", "Repository link not found");
const conflict = (c: Context<AppEnv>, resource: string, revision: number) =>
  failure(
    c,
    412,
    "revision-conflict",
    `${resource} changed; current revision is ${revision}`,
    { revision, resource },
  );

async function readJson(c: Context<AppEnv>) {
  try {
    return { ok: true as const, body: (await c.req.json()) as unknown };
  } catch {
    return { ok: false as const };
  }
}

// GET /api/repos -- Linked repositories with both policies and revisions
repos.get("/", async (c) => {
  const authz = await requireProjectOwnerHttp(c);
  if (authz) return authz;
  const host = c.req.query("host");
  if (host !== undefined && hostOf(c) === null)
    return failure(c, 400, "validation-error", "host must be a hostname");
  return c.json({
    ok: true,
    repos: await new RepoAllowlistStore(c.env.DB).listLinks(
      c.get("tokenResult").projectId,
      host === undefined ? undefined : (hostOf(c) ?? undefined),
    ),
  });
});

// POST /api/repos -- Register a GitHub repo in the allowlist
repos.post("/", async (c) => {
  const authz = await ownerWrite(c);
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
          code: "validation-error",
          message: "Invalid JSON body",
          retryable: false,
        },
      },
      400,
    );
  }

  const parsed = RepoRegisterRequestSchema.safeParse(body);
  if (!parsed.success)
    return zodValidationError(c, parsed.error, "validation-error");

  const {
    owner,
    repo,
    github_host,
    github_token,
    min_read_permission,
    min_write_permission,
    max_permission,
    membership_enabled,
    membership_role_cap,
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
            code: "repo-not-found",
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
            code: "repo-access-denied",
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
            code: "github-api-timeout",
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
          code: "github-api-error",
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
    maxPermission: max_permission,
    membershipEnabled: membership_enabled,
    membershipRoleCap: membership_role_cap,
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

// GET /api/repos/:repoId/access-policy -- Read human repository access policy
repos.get("/:repoId/access-policy", async (c) => {
  const authz = await requireProjectOwnerHttp(c);
  if (authz) return authz;
  const t = target(c);
  if (t instanceof Response) return t;
  const result = await new RepoAllowlistStore(c.env.DB).getAccessPolicy(
    t.projectId,
    t.host,
    t.repoId,
  );
  if (result.status === "not-found") return notFound(c);
  if (result.status !== "ok")
    return failure(
      c,
      500,
      "access-policy-invalid",
      "Stored repository access policy is invalid",
    );
  return c.json({
    ok: true,
    github_repo_id: t.repoId,
    policy: result.policy,
    revision: result.revision,
  });
});

// PUT /api/repos/:repoId/access-policy -- Replace the human access policy;
// `expected_revision` makes the write conditional on the reviewed revision.
repos.put("/:repoId/access-policy", async (c) => {
  const authz = await ownerWrite(c);
  if (authz) return authz;
  const t = target(c);
  if (t instanceof Response) return t;
  const raw = await readJson(c);
  if (!raw.ok) return failure(c, 400, "validation-error", "Invalid JSON body");
  const parsed = RepoAccessPolicyRequestSchema.safeParse(raw.body);
  if (!parsed.success)
    return zodValidationError(c, parsed.error, "validation-error");
  const precondition = RepoPolicyPreconditionSchema.safeParse(raw.body);
  if (!precondition.success)
    return zodValidationError(c, precondition.error, "validation-error");
  const result = await new RepoAllowlistStore(c.env.DB).setAccessPolicy(
    t.projectId,
    t.host,
    t.repoId,
    parsed.data,
    precondition.data.expected_revision,
  );
  if (result.status === "not-found") return notFound(c);
  if (result.status === "conflict")
    return conflict(
      c,
      `repo:${t.host}/${t.repoId}:access-policy`,
      result.revision,
    );
  if (result.status !== "ok")
    return failure(
      c,
      500,
      "access-policy-invalid",
      "Stored repository access policy is invalid",
    );
  return c.json({
    ok: true,
    github_repo_id: t.repoId,
    policy: result.policy,
    revision: result.revision,
  });
});

// GET /api/repos/:repoId/oidc-policy -- Read the complete Actions OIDC policy
repos.get("/:repoId/oidc-policy", async (c) => {
  const authz = await requireProjectOwnerHttp(c);
  if (authz) return authz;
  const t = target(c);
  if (t instanceof Response) return t;
  const result = await new RepoAllowlistStore(c.env.DB).getOidcPolicy(
    t.projectId,
    t.host,
    t.repoId,
  );
  if (result.status === "not-found") return notFound(c);
  if (result.status !== "ok")
    return failure(
      c,
      500,
      "oidc-policy-invalid",
      "Stored repository OIDC policy is invalid",
    );
  return c.json({
    ok: true,
    github_repo_id: t.repoId,
    policy: result.policy,
    revision: result.revision,
  });
});

// PUT /api/repos/:repoId/oidc-policy -- Replace the complete Actions OIDC
// policy; `expected_revision` makes the write conditional.
repos.put("/:repoId/oidc-policy", async (c) => {
  const authz = await ownerWrite(c);
  if (authz) return authz;
  const t = target(c);
  if (t instanceof Response) return t;
  const raw = await readJson(c);
  if (!raw.ok) return failure(c, 400, "validation-error", "Invalid JSON body");
  const parsed = RepoOidcPolicyRequestSchema.safeParse(raw.body);
  if (!parsed.success)
    return zodValidationError(c, parsed.error, "validation-error");
  const precondition = RepoPolicyPreconditionSchema.safeParse(raw.body);
  if (!precondition.success)
    return zodValidationError(c, precondition.error, "validation-error");
  const result = await new RepoAllowlistStore(c.env.DB).setOidcPolicy(
    t.projectId,
    t.host,
    t.repoId,
    parsed.data,
    precondition.data.expected_revision,
  );
  if (result.status === "not-found") return notFound(c);
  if (result.status === "conflict")
    return conflict(
      c,
      `repo:${t.host}/${t.repoId}:oidc-policy`,
      result.revision,
    );
  if (result.status !== "ok")
    return failure(
      c,
      500,
      "oidc-policy-invalid",
      "Stored repository OIDC policy is invalid",
    );
  return c.json({
    ok: true,
    github_repo_id: t.repoId,
    policy: result.policy,
    revision: result.revision,
  });
});

// DELETE /api/repos/:repoId -- Remove a repository link (idempotent). With
// `?expected_revision=` it removes only the reviewed access-policy revision.
// Explicit project memberships are independent and never removed here.
repos.delete("/:repoId", async (c) => {
  const authz = await ownerWrite(c);
  if (authz) return authz;
  const t = target(c);
  if (t instanceof Response) return t;
  const raw = c.req.query("expected_revision");
  const expected =
    RepoPolicyPreconditionSchema.shape.expected_revision.safeParse(
      raw === undefined ? undefined : Number(raw),
    );
  if (!expected.success)
    return zodValidationError(c, expected.error, "validation-error");
  const result = await new RepoAllowlistStore(c.env.DB).remove(
    t.projectId,
    t.host,
    t.repoId,
    expected.data,
  );
  if (result.status === "conflict")
    return conflict(
      c,
      `repo:${t.host}/${t.repoId}:access-policy`,
      result.revision,
    );
  if (result.status === "not-found" && expected.data !== undefined)
    return notFound(c);
  return c.json({
    ok: true,
    github_repo_id: t.repoId,
    removed_at: Math.floor(Date.now() / 1000),
  });
});
