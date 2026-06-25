/**
 * Generic OIDC token exchange route — `POST /api/auth/oidc/exchange`.
 *
 * Accepts a non-GitHub OIDC ID token and exchanges it for a tila session
 * token, keyed on the `(project_id, oidc_issuer, sub)` triple.
 *
 * Security model
 * --------------
 * - Issuer and audience come **exclusively** from per-project D1 config
 *   (`_projects.oidc_issuer` / `_projects.oidc_audience`) — never from
 *   the incoming token or request body.
 * - The principal `(project_id, issuer, subject)` is verified against the
 *   `_oidc_principals` allowlist (`OidcPrincipalsStore`).
 * - Every deny path after token presentation calls `recordExchangeFailure`
 *   to feed the shared per-IP rate-limit counter.
 * - Analytics writes are wrapped in try/catch and are never load-bearing.
 * - The D1 project-config lookup is wrapped in try/catch; any throw →
 *   fail-closed 502 (security item 7 / test case j).
 * - `oidc-session` tokens carry no GitHub fields and are structurally
 *   unreachable from the admin-roster path (`requireProjectAdmin`).
 *
 * @module
 */

import {
  D1IdempotencyStore,
  D1RateLimitStore,
  OidcPrincipalsStore,
} from "@tila/backend-d1";
import {
  OidcExchangeRequestSchema,
  SessionPermissionSchema,
} from "@tila/schemas";
import { type Context, Hono } from "hono";
import { RATE_LIMIT_WINDOW_MS, SESSION_TTL_SECONDS_BY_TIER } from "../config";
import { OidcDiscoveryError, resolveJwksUri } from "../lib/oidc-discovery";
import { OidcVerificationError, verifyOidcJwt } from "../lib/oidc-verify";
import { asEpochSeconds, nowSeconds } from "../lib/time";
import type { Env, HonoVariables } from "../types";
import {
  checkExchangeRateLimit,
  mintSessionToken,
  recordExchangeFailure,
} from "./auth-github";

type AppEnv = { Bindings: Env; Variables: HonoVariables };

export const authOidc = new Hono<AppEnv>();

// ---------------------------------------------------------------------------
// Analytics helpers (never load-bearing)
// ---------------------------------------------------------------------------

function emitIssuerRejectedAnalytics(
  env: { ANALYTICS: AnalyticsEngineDataset },
  subLabel?: string,
): void {
  try {
    const blobs = ["auth", "oidc_exchange", "issuer_rejected"];
    if (subLabel) blobs.push(subLabel);
    env.ANALYTICS.writeDataPoint({
      blobs,
      doubles: [1],
      indexes: ["oidc"],
    });
  } catch {
    // Analytics is never load-bearing
  }
}

function emitPrincipalNotAllowedAnalytics(env: {
  ANALYTICS: AnalyticsEngineDataset;
}): void {
  try {
    env.ANALYTICS.writeDataPoint({
      blobs: ["auth", "oidc_exchange", "principal_not_allowed"],
      doubles: [1],
      indexes: ["oidc"],
    });
  } catch {
    // Analytics is never load-bearing
  }
}

// ---------------------------------------------------------------------------
// Idempotency helper (inline, avoids re-importing checkIdempotentExchange
// which takes a raw db param not needed here)
// ---------------------------------------------------------------------------

async function checkCachedExchange(
  store: D1IdempotencyStore,
  key: string,
  projectId: string,
  db: D1Database,
): Promise<Record<string, unknown> | null> {
  const cached = await store.check(key, projectId);
  if (!cached) return null;
  try {
    const body = JSON.parse(cached.body) as { expires_at?: number };
    if (body.expires_at && asEpochSeconds(body.expires_at) > nowSeconds()) {
      return body;
    }
    // Stale — delete so the next request re-exchanges
    await db.prepare("DELETE FROM _idempotency WHERE key = ?").bind(key).run();
  } catch {
    // Malformed cache entry — proceed with fresh exchange
  }
  return null;
}

// ---------------------------------------------------------------------------
// POST /exchange
// ---------------------------------------------------------------------------

authOidc.post("/exchange", async (c) => {
  const ip = c.req.raw.headers.get("CF-Connecting-IP");

  // 1. Rate limit guard
  const limited = await checkExchangeRateLimit(c);
  if (limited) return limited;

  // 2. Parse and validate body
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

  const parsed = OidcExchangeRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      {
        ok: false,
        error: {
          code: "validation-error",
          message: "Invalid request body",
          retryable: false,
        },
      },
      400,
    );
  }

  const { project_id, oidc_token } = parsed.data;

  // 3. Require HMAC key
  const hmacKey = c.env.GITHUB_SESSION_HMAC_KEY;
  if (!hmacKey) {
    console.error("[auth-oidc] GITHUB_SESSION_HMAC_KEY not configured");
    return c.json(
      {
        ok: false,
        error: {
          code: "hmac-not-configured",
          message: "Server configuration error: HMAC signing key not set",
          retryable: false,
        },
      },
      500,
    );
  }

  // 4. Load per-project OIDC config from D1 (fail-closed on D1 error — security item 7/j)
  let oidcIssuer: string | null = null;
  let oidcAudience: string | null = null;
  try {
    const row = await c.env.DB.prepare(
      "SELECT oidc_issuer, oidc_audience FROM _projects WHERE project_id = ?",
    )
      .bind(project_id)
      .first<{ oidc_issuer: string | null; oidc_audience: string | null }>();

    if (row) {
      oidcIssuer = row.oidc_issuer ?? null;
      oidcAudience = row.oidc_audience ?? null;
    }
    // If row is null (project doesn't exist), both remain null → 404 below
  } catch (err) {
    // D1 error → fail-closed 502 (never proceed to mint)
    console.error("[auth-oidc] D1 project config lookup failed:", err);
    return c.json(
      {
        ok: false,
        error: {
          code: "config-unavailable",
          message: "Project configuration temporarily unavailable",
          retryable: true,
        },
      },
      502,
    );
  }

  // Non-existent project and unconfigured project are indistinguishable (security A-5)
  if (!oidcIssuer || !oidcAudience) {
    return c.json(
      {
        ok: false,
        error: {
          code: "oidc-not-configured",
          message: "OIDC exchange is not configured for this project",
          retryable: false,
        },
      },
      404,
    );
  }

  // 5. Resolve jwks_uri via OIDC Discovery
  let jwksUri: string;
  try {
    jwksUri = await resolveJwksUri(oidcIssuer);
  } catch (err) {
    emitIssuerRejectedAnalytics(c.env);
    await recordExchangeFailure(c.env, ip);
    console.error("[auth-oidc] Discovery failed for issuer", oidcIssuer, err);
    return c.json(
      {
        ok: false,
        error: {
          code: "issuer-discovery-failed",
          message: "Failed to resolve issuer JWKS URI via OIDC Discovery",
          retryable: true,
        },
      },
      502,
    );
  }

  // 6. Verify OIDC JWT
  let verifyResult: Awaited<ReturnType<typeof verifyOidcJwt>>;
  try {
    verifyResult = await verifyOidcJwt(oidc_token, {
      issuer: oidcIssuer,
      audience: oidcAudience,
      jwksUri,
    });
  } catch (err) {
    if (err instanceof OidcVerificationError) {
      if (err.code === "oidc-jwks-unavailable") {
        // Retryable — JWKS endpoint temporarily down (security A-1)
        emitIssuerRejectedAnalytics(c.env, "jwks-empty");
        return c.json(
          {
            ok: false,
            error: {
              code: err.code,
              message: err.message,
              retryable: true,
            },
          },
          502,
        );
      }
      // Auth error — record failure + emit analytics
      emitIssuerRejectedAnalytics(c.env);
      await recordExchangeFailure(c.env, ip);
      return c.json(
        {
          ok: false,
          error: {
            code: err.code,
            message: err.message,
            retryable: false,
          },
        },
        401,
      );
    }
    // Unknown error
    console.error("[auth-oidc] verifyOidcJwt failed unexpectedly:", err);
    await recordExchangeFailure(c.env, ip);
    return c.json(
      {
        ok: false,
        error: {
          code: "oidc-invalid-token",
          message: "OIDC token verification failed",
          retryable: false,
        },
      },
      401,
    );
  }

  const payload = verifyResult.payload;

  // 7. Extract and validate subject
  const subject = payload.sub;
  if (typeof subject !== "string" || subject === "") {
    await recordExchangeFailure(c.env, ip);
    return c.json(
      {
        ok: false,
        error: {
          code: "oidc-invalid-token",
          message: "Token payload missing or empty sub claim",
          retryable: false,
        },
      },
      401,
    );
  }
  if (subject.length > 255) {
    await recordExchangeFailure(c.env, ip);
    return c.json(
      {
        ok: false,
        error: {
          code: "oidc-invalid-token",
          message: "Subject exceeds maximum length of 255 characters",
          retryable: false,
        },
      },
      401,
    );
  }

  // 7b. Require jti OR numeric iat (security R-3 — prevents attacker-shapeable idempotency key)
  const jti = payload.jti;
  const iat = payload.iat;
  const hasJti = typeof jti === "string" && jti !== "";
  const hasNumericIat = typeof iat === "number";
  if (!hasJti && !hasNumericIat) {
    await recordExchangeFailure(c.env, ip);
    return c.json(
      {
        ok: false,
        error: {
          code: "oidc-invalid-token",
          message:
            "Token must carry jti or a numeric iat for idempotency key derivation",
          retryable: false,
        },
      },
      401,
    );
  }

  // 8. Idempotency check — distinct `oidc-generic:` namespace (security R-3)
  const idempotencyKey = `oidc-generic:${project_id}:${oidcIssuer}:${hasJti ? jti : `${subject}:${iat}`}`;
  const idempotencyStore = new D1IdempotencyStore(c.env.DB);

  const cachedBody = await checkCachedExchange(
    idempotencyStore,
    idempotencyKey,
    project_id,
    c.env.DB,
  );
  if (cachedBody) {
    return c.json(cachedBody, 200);
  }

  // 9. Principal allowlist check
  const principalsStore = new OidcPrincipalsStore(c.env.DB);
  const principalRow = await principalsStore.isAllowed(
    project_id,
    oidcIssuer,
    subject,
  );
  if (!principalRow) {
    emitPrincipalNotAllowedAnalytics(c.env);
    await recordExchangeFailure(c.env, ip);
    return c.json(
      {
        ok: false,
        error: {
          code: "principal-not-allowed",
          message:
            "Principal is not registered or is disabled for this project",
          retryable: false,
        },
      },
      403,
    );
  }

  // 10. Validate permission (default to read on failure — least privilege)
  const permissionParsed = SessionPermissionSchema.safeParse(
    principalRow.permission,
  );
  if (!permissionParsed.success) {
    console.warn(
      `[auth-oidc] principal (${project_id}, ${oidcIssuer}, ${subject}) has unrecognized permission "${principalRow.permission}"; defaulting to "read"`,
    );
  }
  const permission = permissionParsed.success ? permissionParsed.data : "read";

  // 11. Mint and store OIDC session
  const responseBody = await mintAndStoreOidcSession({
    projectId: project_id,
    oidcIssuer,
    subject,
    permission,
    hmacKey,
    idempotencyStore,
    idempotencyKey,
  });

  return c.json(responseBody, 200);
});

// ---------------------------------------------------------------------------
// mintAndStoreOidcSession helper
// ---------------------------------------------------------------------------

async function mintAndStoreOidcSession(opts: {
  projectId: string;
  oidcIssuer: string;
  subject: string;
  permission: "read" | "write" | "admin";
  hmacKey: string;
  idempotencyStore: D1IdempotencyStore;
  idempotencyKey: string;
}): Promise<Record<string, unknown>> {
  const {
    projectId,
    oidcIssuer,
    subject,
    permission,
    hmacKey,
    idempotencyStore,
    idempotencyKey,
  } = opts;

  const now = nowSeconds();
  // WI-H tiered TTL: admin gets shortest TTL to bound post-offboarding exposure
  const ttlSeconds =
    SESSION_TTL_SECONDS_BY_TIER[permission] ?? SESSION_TTL_SECONDS_BY_TIER.read;
  const expiresAt = now + ttlSeconds;
  const sessionJti = crypto.randomUUID();

  const payload: Record<string, unknown> = {
    project_id: projectId,
    sub_type: "oidc",
    oidc_issuer: oidcIssuer,
    oidc_subject: subject,
    actor_name: subject,
    permission,
    expires_at: expiresAt,
    issued_at: now,
    jti: sessionJti,
  };

  // Wrap mintSessionToken in try/catch — an HMAC error must never yield a partial grant
  let sessionToken: string;
  try {
    sessionToken = await mintSessionToken(payload, hmacKey);
  } catch (err) {
    console.error("[auth-oidc] mintSessionToken failed:", err);
    // Re-throw as a 500-worthy error; the route's outer handler must catch
    throw err;
  }

  const responseBody: Record<string, unknown> = {
    ok: true,
    session_token: sessionToken,
    expires_at: expiresAt,
    project_id: projectId,
    oidc_issuer: oidcIssuer,
    oidc_subject: subject,
    permission,
  };

  // Store idempotency record (non-fatal — response is still valid)
  try {
    await idempotencyStore.store(
      idempotencyKey,
      projectId,
      200,
      JSON.stringify(responseBody),
    );
  } catch {
    // Non-fatal
  }

  return responseBody;
}
