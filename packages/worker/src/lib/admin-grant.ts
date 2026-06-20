/**
 * Shared admin grant helper — extracted from admin-roster.ts POST /.
 *
 * Owns: GrantBodySchema validation (first step — before any outbound call),
 * the direct github_user_id path, the login path (GitHub App preconditions →
 * mintAppJwt/getInstallationAccessToken/getUserByLogin), and the isActiveAdmin
 * pre-check + AdminGrantsStore.grant.
 *
 * Returns a discriminated GrantResult carrying a stable `outcome` token so
 * each caller can map it to its own analytics vocabulary. Analytics stays
 * in each caller — this helper is pure (no analytics binding coupling).
 *
 * SECURITY: Never serialize or log `env` (holds GITHUB_APP_PRIVATE_KEY)
 * or any GitHub token / Authorization header value.
 */
import { AdminGrantsStore, GitHubAppConfigStore } from "@tila/backend-d1";
import { GITHUB_LOGIN_REGEX } from "@tila/schemas";
import { z } from "zod";
import type { Env } from "../types";
import { getInstallationAccessToken, mintAppJwt } from "./github-app";
import { getUserByLogin } from "./github-client";

// ─── Request body schema ────────────────────────────────────────────────────
//
// GitHub username format: 1–39 chars, alphanumeric or single hyphens (not at
// start/end). Uses the shared GITHUB_LOGIN_REGEX from @tila/schemas.
// Validated BEFORE any outbound call to eliminate malformed-URL /
// token-leak-via-bad-path risk in GET /users/{login}.
export const GrantBodySchema = z
  .object({
    github_user_id: z.number().int().positive().optional(),
    login: z.string().min(1).max(39).regex(GITHUB_LOGIN_REGEX).optional(),
  })
  .refine((v) => (v.github_user_id !== undefined) !== (v.login !== undefined), {
    message: "Provide exactly one of github_user_id or login",
  });

export type GrantBody = z.infer<typeof GrantBodySchema>;

// ─── Outcome type ───────────────────────────────────────────────────────────
export type GrantOutcome =
  | "success"
  | "validation-error"
  | "login-unresolved"
  | "github-user-not-found"
  | "github-error";

// ─── Result type ────────────────────────────────────────────────────────────
export type GrantResult =
  | {
      ok: true;
      githubUserId: number;
      granted: boolean;
      outcome: "success";
      status: 200;
    }
  | {
      ok: false;
      outcome: GrantOutcome;
      status: 400 | 422 | 404 | 502;
      code: string;
      message: string;
    };

/**
 * Apply an admin grant for a project.
 *
 * @param env - Worker bindings (NEVER logged — holds GITHUB_APP_PRIVATE_KEY)
 * @param projectId - The project to grant admin access to
 * @param body - Raw request body (validated by GrantBodySchema internally)
 * @param grantedByUserId - The granting admin's GitHub user id, or null for
 *   infra/owner-seeded grants
 *
 * Returns camelCase `githubUserId`; each route maps to its snake_case
 * `github_user_id` JSON field.
 */
export async function applyAdminGrant(
  env: Env,
  projectId: string,
  body: unknown,
  grantedByUserId: number | null,
): Promise<GrantResult> {
  // ── Step 1: Validate body FIRST — before any outbound call ────────────────
  const parsed = GrantBodySchema.safeParse(body);
  if (!parsed.success) {
    return {
      ok: false,
      outcome: "validation-error",
      status: 400,
      code: "validation-error",
      message:
        parsed.error.errors[0]?.message ??
        "Provide exactly one of github_user_id or login",
    };
  }

  const { github_user_id: directId, login } = parsed.data;

  let githubUserId: number;
  let githubLoginSnapshot: string | null = null;

  if (directId !== undefined) {
    // ── Direct github_user_id path ──────────────────────────────────────────
    // login_snapshot is left null on the direct-id path (no resolution step).
    githubUserId = directId;
  } else {
    // ── Login resolution path ───────────────────────────────────────────────
    // Gate on three preconditions: GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY secrets
    // AND a per-project _github_app_config installation row.
    // Any missing → 422 login-unresolved.
    if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY) {
      return {
        ok: false,
        outcome: "login-unresolved",
        status: 422,
        code: "login-unresolved",
        message:
          "GitHub App not configured; pass github_user_id instead of login",
      };
    }

    const configStore = new GitHubAppConfigStore(env.DB);
    const installation = await configStore.getInstallation(projectId);
    if (!installation) {
      return {
        ok: false,
        outcome: "login-unresolved",
        status: 422,
        code: "login-unresolved",
        message:
          "No GitHub App installation found for this project; pass github_user_id instead of login",
      };
    }

    // Deliberate divergence from repos.ts warn-and-continue: a failed admin
    // grant must not silently proceed → map throws to 502 github-error.
    let installationToken: string;
    try {
      const appJwt = await mintAppJwt(
        Number(env.GITHUB_APP_ID),
        env.GITHUB_APP_PRIVATE_KEY,
      );
      installationToken = await getInstallationAccessToken(
        appJwt,
        installation.installation_id,
      );
    } catch (err) {
      // Logging hygiene: log only error type/message — NEVER the token or
      // Authorization header value.
      console.error(
        "[admin-grant] App token acquisition failed:",
        err instanceof Error ? err.message : String(err),
      );
      return {
        ok: false,
        outcome: "github-error",
        status: 502,
        code: "github-error",
        message: "GitHub App token acquisition failed",
      };
    }

    // Resolve login → id. AbortError/timeout surfaces as a throw → 502.
    let resolved: { login: string; id: number } | null;
    try {
      resolved = await getUserByLogin(installationToken, login as string);
    } catch (err) {
      // Logging hygiene: log only error type/message — NEVER the token.
      console.error(
        "[admin-grant] getUserByLogin failed:",
        err instanceof Error ? err.message : String(err),
      );
      return {
        ok: false,
        outcome: "github-error",
        status: 502,
        code: "github-error",
        message: "GitHub user lookup failed",
      };
    }

    if (resolved === null) {
      return {
        ok: false,
        outcome: "github-user-not-found",
        status: 404,
        code: "github-user-not-found",
        message: `GitHub user '${login}' not found`,
      };
    }

    githubUserId = resolved.id;
    githubLoginSnapshot = resolved.login;
  }

  // ── Grant (idempotent) ────────────────────────────────────────────────────
  const store = new AdminGrantsStore(env.DB);

  // Pre-check: derive granted boolean without modifying AdminGrantsStore interface.
  // Non-transactional race is accepted (documented in design C2).
  const alreadyAdmin = await store.isActiveAdmin(
    projectId,
    "github.com",
    githubUserId,
  );

  if (!alreadyAdmin) {
    await store.grant({
      projectId,
      githubUserId,
      githubLoginSnapshot: githubLoginSnapshot ?? undefined,
      grantedByUserId: grantedByUserId ?? undefined,
      githubHost: "github.com",
    });
  }

  const granted = !alreadyAdmin;

  return {
    ok: true,
    githubUserId,
    granted,
    outcome: "success",
    status: 200,
  };
}
