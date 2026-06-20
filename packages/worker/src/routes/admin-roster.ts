import { AdminGrantsStore, GitHubAppConfigStore } from "@tila/backend-d1";
import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import {
  type AdminRosterOutcome,
  emitAdminRosterDatapoint,
} from "../lib/analytics";
import { getInstallationAccessToken, mintAppJwt } from "../lib/github-app";
import { getUserByLogin } from "../lib/github-client";
import {
  requireProjectAdmin,
  revokeAdminGrantInCache,
} from "../middleware/require-project-admin";
import type { Env, HonoVariables } from "../types";

type AdminEnv = { Bindings: Env; Variables: HonoVariables };

export const adminRoster = new Hono<AdminEnv>();

// ─── Request body schema ────────────────────────────────────────────────────
//
// GitHub username format: 1–39 chars, alphanumeric or single hyphens (not
// at start/end). Validated BEFORE any outbound call to eliminate
// malformed-URL / token-leak-via-bad-path risk in GET /users/{login}.
const GrantBodySchema = z
  .object({
    github_user_id: z.number().int().positive().optional(),
    login: z
      .string()
      .min(1)
      .max(39)
      .regex(/^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i)
      .optional(),
  })
  .refine((v) => (v.github_user_id !== undefined) !== (v.login !== undefined), {
    message: "Provide exactly one of github_user_id or login",
  });

// ─── Helper: emit analytics (fire-and-forget) ───────────────────────────────
// executionCtx may be absent in test environments (no Worker runtime);
// emitAdminRosterDatapoint accepts ctx:undefined and falls back to inline emission.
function emit(
  c: Context<AdminEnv>,
  action: "grant" | "revoke",
  outcome: AdminRosterOutcome,
  statusCode: number,
): void {
  const projectId = c.get("projectId") ?? "";
  let ctx: ExecutionContext | undefined;
  try {
    ctx = c.executionCtx;
  } catch {
    // No ExecutionContext in test environment — inline emission via undefined.
    ctx = undefined;
  }
  emitAdminRosterDatapoint(c.env.ANALYTICS, ctx, {
    projectId,
    action,
    outcome,
    statusCode,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// GET / — list active admins
// ─────────────────────────────────────────────────────────────────────────────
adminRoster.get("/", requireProjectAdmin, async (c) => {
  const projectId = c.get("projectId");
  const store = new AdminGrantsStore(c.env.DB);
  const rows = await store.list(projectId);

  const admins = rows.map((r) => ({
    github_user_id: r.github_user_id,
    login: r.github_login_snapshot,
    granted_by: r.granted_by_user_id,
    granted_at: r.granted_at,
  }));

  return c.json({ ok: true, admins });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST / — grant admin (by github_user_id or login)
// ─────────────────────────────────────────────────────────────────────────────
adminRoster.post("/", requireProjectAdmin, async (c) => {
  const projectId = c.get("projectId");
  const tokenResult = c.get("tokenResult");

  // Parse and validate body
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

  const parsed = GrantBodySchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      {
        ok: false,
        error: {
          code: "validation-error",
          message:
            parsed.error.errors[0]?.message ??
            "Provide exactly one of github_user_id or login",
          retryable: false,
        },
      },
      400,
    );
  }

  const { github_user_id: directId, login } = parsed.data;

  // Resolve the acting admin's identity.
  // kind:"session" → githubUserId (require-project-admin.ts:131 already rejected
  // null-identity sessions, so the handler may treat it as present).
  // kind:"d1-token" → null (infra-owner-seeded grant; no GitHub identity).
  const grantedByUserId =
    tokenResult.kind === "session" ? (tokenResult.githubUserId ?? null) : null;

  let githubUserId: number;
  let githubLoginSnapshot: string | null = null;

  if (directId !== undefined) {
    // ── Direct github_user_id path ────────────────────────────────────────
    // login_snapshot is left null on the direct-id path (no resolution step).
    githubUserId = directId;
  } else {
    // ── Login resolution path ─────────────────────────────────────────────
    // Gate on three preconditions: GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY secrets
    // AND a per-project _github_app_config installation row.
    // Any missing → 422 login-unresolved (emit denied datapoint).
    if (!c.env.GITHUB_APP_ID || !c.env.GITHUB_APP_PRIVATE_KEY) {
      emit(c, "grant", "login-unresolved", 422);
      return c.json(
        {
          ok: false,
          error: {
            code: "login-unresolved",
            message:
              "GitHub App not configured; pass github_user_id instead of login",
            retryable: false,
          },
        },
        422,
      );
    }

    const configStore = new GitHubAppConfigStore(c.env.DB);
    const installation = await configStore.getInstallation(projectId);
    if (!installation) {
      emit(c, "grant", "login-unresolved", 422);
      return c.json(
        {
          ok: false,
          error: {
            code: "login-unresolved",
            message:
              "No GitHub App installation found for this project; pass github_user_id instead of login",
            retryable: false,
          },
        },
        422,
      );
    }

    // Deliberate divergence from repos.ts warn-and-continue: a failed admin
    // grant must not silently proceed → map throws to 502 github-error.
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
      // Logging hygiene: log only error type/message — NEVER the token or
      // Authorization header value.
      console.error(
        "[admin-roster] App token acquisition failed:",
        err instanceof Error ? err.message : String(err),
      );
      emit(c, "grant", "github-error", 502);
      return c.json(
        {
          ok: false,
          error: {
            code: "github-error",
            message: "GitHub App token acquisition failed",
            retryable: true,
          },
        },
        502,
      );
    }

    // Resolve login → id. AbortError/timeout surfaces as a throw → 502.
    let resolved: { login: string; id: number } | null;
    try {
      resolved = await getUserByLogin(installationToken, login as string);
    } catch (err) {
      // Logging hygiene: log only error type/message — NEVER the token.
      console.error(
        "[admin-roster] getUserByLogin failed:",
        err instanceof Error ? err.message : String(err),
      );
      emit(c, "grant", "github-error", 502);
      return c.json(
        {
          ok: false,
          error: {
            code: "github-error",
            message: "GitHub user lookup failed",
            retryable: true,
          },
        },
        502,
      );
    }

    if (resolved === null) {
      emit(c, "grant", "github-user-not-found", 404);
      return c.json(
        {
          ok: false,
          error: {
            code: "github-user-not-found",
            message: `GitHub user '${login}' not found`,
            retryable: false,
          },
        },
        404,
      );
    }

    githubUserId = resolved.id;
    githubLoginSnapshot = resolved.login;
  }

  // ── Grant (idempotent) ──────────────────────────────────────────────────
  const store = new AdminGrantsStore(c.env.DB);

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

  emit(c, "grant", "success", 200);
  return c.json({ ok: true, github_user_id: githubUserId, granted });
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /:githubUserId — revoke admin
// ─────────────────────────────────────────────────────────────────────────────
adminRoster.delete("/:githubUserId", requireProjectAdmin, async (c) => {
  const projectId = c.get("projectId");
  const tokenResult = c.get("tokenResult");

  // Parse and validate path param
  const rawId = c.req.param("githubUserId");
  const parsed = Number(rawId);
  if (!Number.isInteger(parsed) || parsed <= 0 || String(parsed) !== rawId) {
    return c.json(
      {
        ok: false,
        error: {
          code: "validation-error",
          message: "githubUserId must be a positive integer",
          retryable: false,
        },
      },
      400,
    );
  }
  const targetUserId = parsed;

  const store = new AdminGrantsStore(c.env.DB);

  // Call list() once — used for both the last-admin guard AND the revoked boolean.
  const activeAdmins = await store.list(projectId);
  const isTargetActive = activeAdmins.some(
    (r) => r.github_user_id === targetUserId,
  );

  // Resolve actor identity (d1-token → null, session → githubUserId).
  // require-project-admin.ts:131 already rejected null-identity sessions.
  const callerUserId =
    tokenResult.kind === "session" ? (tokenResult.githubUserId ?? null) : null;
  const isD1Token = tokenResult.kind === "d1-token";

  // ── Last-admin guard ────────────────────────────────────────────────────
  // Guard: active roster count==1 AND sole row id==target AND bearer caller
  // githubUserId==target → 409 last-admin (emit denied datapoint), grant untouched.
  // Full-scope D1 tokens bypass the guard (bootstrap escape hatch).
  if (
    !isD1Token &&
    activeAdmins.length === 1 &&
    activeAdmins[0]?.github_user_id === targetUserId &&
    callerUserId === targetUserId
  ) {
    emit(c, "revoke", "last-admin", 409);
    return c.json(
      {
        ok: false,
        error: {
          code: "last-admin",
          message:
            "Cannot revoke the last admin; grant another admin first or use a D1 bootstrap token",
          retryable: false,
        },
      },
      409,
    );
  }

  // Revoke (soft-delete; double-revoke is a no-op → still 200 with revoked:false).
  const revokedByUserId = callerUserId;
  await store.revoke(
    projectId,
    "github.com",
    targetUserId,
    revokedByUserId ?? undefined,
  );

  // ── Same-isolate cache purge ────────────────────────────────────────────
  // Cache key MUST match require-project-admin.ts:137:
  //   `${projectId}:${githubHost}:${githubUserId}`
  // The literal "github.com" here is tied to that middleware key.
  // CROSS-MODULE INVARIANT: if the host token in require-project-admin.ts:137
  // ever changes (e.g. GHES support), this purge key must change in lockstep.
  // Failing to do so would leave a stale cache entry for the revoked user.
  revokeAdminGrantInCache(`${projectId}:github.com:${targetUserId}`);

  emit(c, "revoke", "success", 200);
  return c.json({
    ok: true,
    github_user_id: targetUserId,
    revoked: isTargetActive,
  });
});
