import { D1SessionStore, revokePrincipalBatch } from "@tila/backend-d1";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import { adminCacheKey } from "../lib/admin-cache-key";
import { archiveJournal, revokeSession } from "../lib/admin-ops";
import { destroyProjectResources } from "../lib/destroy-project";
import { forwardToDO } from "../lib/do-forward";
import { nowMs, nowSeconds } from "../lib/time";
import { invalidate } from "../lib/token-cache";
import { revokeSubjectInCache } from "../middleware/auth";
import { requirePermission } from "../middleware/permission";
import {
  requireProjectAdmin,
  revokeAdminGrantInCache,
} from "../middleware/require-project-admin";
import type { Env, HonoVariables } from "../types";
import { checkExchangeRateLimit } from "./auth-github";

type AdminEnv = { Bindings: Env; Variables: HonoVariables };

/**
 * Guards destroy/store-counts routes so only full-scope D1 API tokens
 * can reach them. GitHub session tokens (kind "session") with
 * permission==="admin" pass requirePermission("admin") but must not be
 * allowed to trigger destructive infra-owner operations.
 *
 * INVARIANT: requireProjectAdmin must NEVER replace or weaken requireD1Token on destroy/archive/store-counts/sessions.revoke (irreversible ops).
 */
export const requireD1Token: MiddlewareHandler<AdminEnv> = async (c, next) => {
  const tokenResult = c.get("tokenResult");
  if (tokenResult.kind !== "d1-token") {
    return c.json(
      {
        ok: false,
        error: {
          code: "d1-token-required",
          message: "This operation requires a full-scope D1 API token",
          retryable: false,
        },
      },
      403,
    );
  }
  return next();
};

export const admin = new Hono<AdminEnv>();
const RevokeSessionRequestSchema = z.object({
  jti: z.string().uuid().max(64),
});

const RevokePrincipalRequestSchema = z.object({
  host: z.string().min(1).max(255).optional(),
  revoke_tokens: z.array(z.string().min(1).max(255)).max(50).optional(),
});

admin.post("/restart", requireProjectAdmin, async (c) => {
  const stub = c.get("doStub");
  return forwardToDO(stub, "/admin/restart", "POST");
});

admin.post(
  "/archive/journal",
  requirePermission("admin"),
  requireD1Token,
  async (c) => {
    const stub = c.get("doStub");
    const projectId = c.get("projectId");
    const result = await archiveJournal(c.env, stub, projectId);
    return c.json(result.body, result.status as ContentfulStatusCode);
  },
);

/**
 * GET /admin/store-counts
 * Returns per-table row counts from the project's DO (for destroy read-back
 * verification). Requires a full-scope D1 API token — GitHub session tokens
 * with admin permission are explicitly rejected.
 */
admin.get(
  "/store-counts",
  requirePermission("admin"),
  requireD1Token,
  async (c) => {
    const stub = c.get("doStub");
    return forwardToDO(stub, "/admin/store-counts", "GET");
  },
);

/**
 * POST /admin/destroy
 *
 * Per-project entry point to the shared destroy orchestration
 * (see lib/destroy-project.ts). Authenticated by a per-project full-scope D1
 * token. The infra-owner entry point (POST /_internal/admin/projects/:projectId/destroy)
 * runs the SAME orchestration under a different auth model.
 */
admin.post(
  "/destroy",
  requirePermission("admin"),
  requireD1Token,
  async (c) => {
    const stub = c.get("doStub");
    const projectId = c.get("projectId");
    const result = await destroyProjectResources(c.env, stub, projectId);
    return c.json(result.body, result.status as ContentfulStatusCode);
  },
);

/**
 * POST /admin/sessions/revoke
 *
 * Admin-plane endpoint (C9) to revoke a session JWT by jti.
 * Guarded by requirePermission("admin") per flow-separation.md.
 *
 * Body: { jti: string }
 *
 * Inserts the jti into the D1 _revoked_jti table and immediately
 * invalidates the per-isolate cache entry in the revoking isolate.
 * Cross-isolate staleness: ≤ JTI_REVCHECK_TTL_MS (default 60s).
 */
admin.post(
  "/sessions/revoke",
  requirePermission("admin"),
  requireD1Token,
  async (c) => {
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

    const parsed = RevokeSessionRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          ok: false,
          error: {
            code: "validation-error",
            message:
              "Body must include a UUID jti no longer than 64 characters",
            retryable: false,
          },
        },
        400,
      );
    }

    const { jti } = parsed.data;
    const projectId = c.get("projectId") ?? "";

    const result = await revokeSession(c.env, jti, projectId);
    return c.json(result);
  },
);

/**
 * POST /admin/principals/:id/revoke — atomic principal offboard (WI-D).
 *
 * `:id` is the GitHub subject (user id). In a single `db.batch()` (one implicit
 * D1 transaction) this:
 *   1. soft-deletes the principal's active `_admin_grants` rows;
 *   2. arms a `_revoked_subjects` tombstone (`revoked_before = nowMs()`) — a
 *      single O(1) write that denies ALL of that principal's live sessions at
 *      verify time (auth.ts), so no per-session enumeration is needed;
 *   3. revokes any explicitly-named `_tokens` (`revoke_tokens[]`).
 *
 * Gated by `requireProjectAdmin` (a project admin may offboard a principal).
 * No last-admin guard and no D1-token escape hatch: this is a security
 * kill-switch, not roster management — recovery from a self-offboard requires a
 * D1 bootstrap token. `_tokens` has no GitHub-subject linkage, so only the
 * named tokens are revoked (auto-discovery is out of scope).
 */
admin.post("/principals/:id/revoke", requireProjectAdmin, async (c) => {
  // WI-I: check-only shared rate-limit guard (defense-in-depth), applied AFTER
  // requireProjectAdmin so it never weakens the admin-auth gate. Rejects an IP
  // already over the exchange:${ip} threshold; records no failure, so a
  // clean-IP admin is never blocked.
  const limited = await checkExchangeRateLimit(c);
  if (limited) return limited;

  const projectId = c.get("projectId") ?? "";
  const tokenResult = c.get("tokenResult");

  // Validate :id as a positive integer (mirrors admin-roster DELETE).
  const rawId = c.req.param("id");
  const idNum = Number(rawId);
  if (!Number.isInteger(idNum) || idNum <= 0 || String(idNum) !== rawId) {
    return c.json(
      {
        ok: false,
        error: {
          code: "validation-error",
          message: "id must be a positive integer",
          retryable: false,
        },
      },
      400,
    );
  }

  // Tolerate an empty body; malformed JSON → 400 before any write.
  let body: unknown = {};
  const rawBody = await c.req.text();
  if (rawBody.trim() !== "") {
    try {
      body = JSON.parse(rawBody);
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
  }

  const parsed = RevokePrincipalRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      {
        ok: false,
        error: {
          code: "validation-error",
          message:
            "Body may include host (string) and revoke_tokens (string[], max 50)",
          retryable: false,
        },
      },
      400,
    );
  }

  const host = parsed.data.host ?? "github.com";
  const tokenNames = parsed.data.revoke_tokens ?? [];

  // Resolve acting admin identity (session → githubUserId; d1-token → null).
  const callerUserId =
    tokenResult.kind === "session" ? (tokenResult.githubUserId ?? null) : null;
  const revokedBySnapshot =
    callerUserId != null ? `gh:${callerUserId}` : "d1-token";

  let result: Awaited<ReturnType<typeof revokePrincipalBatch>>;
  try {
    result = await revokePrincipalBatch(c.env.DB, {
      projectId,
      host,
      subject: idNum,
      revokedByUserId: callerUserId,
      revokedBySnapshot,
      tokenNames,
      nowMsValue: nowMs(),
      nowSecValue: nowSeconds(),
    });
  } catch (err) {
    // Empty-subject canonicalization throw → 400 (defensive; idNum>0 precludes it).
    if (err instanceof Error && /empty subject/.test(err.message)) {
      return c.json(
        {
          ok: false,
          error: {
            code: "validation-error",
            message: "id canonicalizes to an empty subject",
            retryable: false,
          },
        },
        400,
      );
    }
    console.error("[admin] principal revoke batch failed:", err);
    return c.json(
      {
        ok: false,
        error: {
          code: "revoke-failed",
          message: "Failed to revoke principal",
          retryable: true,
        },
      },
      502,
    );
  }

  // Cache-prime in THIS isolate AFTER the batch commits (never before).
  revokeSubjectInCache(projectId, host, idNum, result.revokedBefore);
  // Use the literal "github.com" host + numeric id — byte-identical to the
  // verifier's admin-grant cache write (require-project-admin.ts) and the
  // admin-roster DELETE purge. GHES/multi-host is not covered here; when it
  // lands, thread the real host through the verifier write and this purge.
  revokeAdminGrantInCache(
    adminCacheKey({ host: "github.com", projectId, userId: idNum }),
  );
  for (const h of result.tokenHashes) invalidate(h);

  // Best-effort cascade: drop sessions minted from any revoked token.
  if (result.tokenHashes.length > 0) {
    const sessionStore = new D1SessionStore(c.env.DB);
    for (const h of result.tokenHashes) {
      try {
        await sessionStore.deleteByTokenHash(h);
      } catch (err) {
        console.error("[admin] principal revoke session cascade failed:", err);
      }
    }
  }

  // Analytics (fire-and-forget, NO PII — never subject_id/login).
  try {
    c.env.ANALYTICS.writeDataPoint({
      blobs: ["auth", "principal-revoke", "success"],
      doubles: [1],
      indexes: ["principal-revoke"],
    });
  } catch {
    // Analytics emission is never load-bearing.
  }

  return c.json({
    ok: true,
    principal: { host, subject_id: String(idNum) },
    grants_revoked: result.grantsRevoked,
    subject_revoked_before: result.revokedBefore,
    tokens_revoked: tokenNames,
  });
});
