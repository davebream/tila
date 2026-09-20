import { ProjectMembershipStore } from "@tila/backend-d1";
import { Hono } from "hono";
import type { Context } from "hono";
import { applyAdminGrant } from "../lib/admin-grant";
import {
  type AdminRosterOutcome,
  emitAdminRosterDatapoint,
} from "../lib/analytics";
import { requireProjectOwner } from "../middleware/require-project-owner";
import type { Env, HonoVariables } from "../types";

type AdminEnv = { Bindings: Env; Variables: HonoVariables };

export const adminRoster = new Hono<AdminEnv>();

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
adminRoster.get("/", requireProjectOwner, async (c) => {
  const projectId = c.get("projectId");
  const store = new ProjectMembershipStore(c.env.DB);
  const rows = (await store.list(projectId)).filter(
    (row) => row.provider === "github" && row.role === "owner",
  );

  const admins = rows.map((r) => ({
    github_user_id: Number(r.subject_id),
    login: r.display_name,
    granted_by: r.granted_by.startsWith("github:github.com:")
      ? Number(r.granted_by.slice("github:github.com:".length))
      : null,
    granted_at: r.granted_at,
  }));

  return c.json({ ok: true, admins });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST / — grant admin (by github_user_id or login)
//
// Thin caller: resolve grantedByUserId from tokenResult, call applyAdminGrant,
// map outcome → emitAdminRosterDatapoint per the design mapping table:
//   success             → emit "success"
//   login-unresolved    → emit "login-unresolved"
//   github-user-not-found → emit "github-user-not-found"
//   github-error        → emit "github-error"
//   validation-error    → 400 returned BEFORE any emit (as today)
//     (validation-error is NOT part of AdminRosterOutcome — the roster caller
//      returns 400 pre-emit; only the free-string emitInfraAdminDatapoint path
//      in the seeder carries it.)
// ─────────────────────────────────────────────────────────────────────────────
adminRoster.post("/", requireProjectOwner, async (c) => {
  const projectId = c.get("projectId");
  const tokenResult = c.get("tokenResult");

  // Parse JSON body first (pre-validation — returns 400 before any emit, as today).
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

  // Resolve the acting admin's identity.
  // kind:"session" → githubUserId (require-project-admin.ts:131 already rejected
  // null-identity sessions, so the handler may treat it as present).
  // kind:"d1-token" → null (infra-owner-seeded grant; no GitHub identity).
  const grantedByUserId =
    tokenResult.kind === "session" ? (tokenResult.githubUserId ?? null) : null;

  // Delegate to the shared grant helper.
  const result = await applyAdminGrant(c.env, projectId, body, grantedByUserId);

  if (!result.ok) {
    // validation-error: return 400 BEFORE any emit (per design invariant).
    if (result.outcome === "validation-error") {
      return c.json(
        {
          ok: false,
          error: {
            code: result.code,
            message: result.message,
            retryable: false,
          },
        },
        400,
      );
    }

    // Map outcome → AdminRosterOutcome and emit.
    // NOTE: validation-error is excluded from AdminRosterOutcome (pre-emit).
    const rosterOutcome = result.outcome as AdminRosterOutcome;
    emit(c, "grant", rosterOutcome, result.status);

    return c.json(
      {
        ok: false,
        error: {
          code: result.code,
          message: result.message,
          retryable: result.status === 502,
        },
      },
      result.status,
    );
  }

  // Success: emit and return.
  emit(c, "grant", "success", 200);
  return c.json({
    ok: true,
    github_user_id: result.githubUserId,
    granted: result.granted,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /:githubUserId — revoke admin
// ─────────────────────────────────────────────────────────────────────────────
adminRoster.delete("/:githubUserId", requireProjectOwner, async (c) => {
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

  const store = new ProjectMembershipStore(c.env.DB);

  // Call list() once — used for both the last-admin guard AND the revoked boolean.
  const activeAdmins = (await store.list(projectId)).filter(
    (row) => row.provider === "github" && row.role === "owner",
  );
  const isTargetActive = activeAdmins.some(
    (r) => r.subject_id === String(targetUserId),
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
    activeAdmins[0]?.subject_id === String(targetUserId) &&
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
  const target = activeAdmins.find(
    (row) => row.subject_id === String(targetUserId),
  );
  if (target) {
    await store.revoke({
      projectId,
      membershipId: target.membership_id,
      actorPrincipalId:
        callerUserId === null
          ? "bootstrap:admin-roster"
          : `github:github.com:${callerUserId}`,
    });
  }

  emit(c, "revoke", "success", 200);
  return c.json({
    ok: true,
    github_user_id: targetUserId,
    revoked: isTargetActive,
  });
});
