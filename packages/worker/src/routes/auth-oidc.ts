import {
  D1IdempotencyStore,
  D1ProjectRegistry,
  OidcPrincipalsStore,
} from "@tila/backend-d1";
import {
  OidcExchangeRequestSchema,
  SessionPermissionSchema,
} from "@tila/schemas";
import { Hono } from "hono";
import { SESSION_TTL_SECONDS } from "../config";
import { ensureDeploymentInstanceId } from "../lib/deployment-instance";
import { OidcDiscoveryError, resolveJwksUri } from "../lib/oidc-discovery";
import { OidcVerificationError, verifyOidcJwt } from "../lib/oidc-verify";
import { nowSeconds } from "../lib/time";
import type { Env, HonoVariables } from "../types";
import {
  checkExchangeRateLimit,
  checkIdempotentExchange,
  mintSessionToken,
  recordExchangeFailure,
} from "./auth-github";

type AppEnv = { Bindings: Env; Variables: HonoVariables };

const MAX_SUBJECT_LEN = 255;

/** Emit a deny-path analytics datapoint. Never load-bearing. */
function emitDeny(
  env: Env,
  event: "issuer_rejected" | "principal_not_allowed",
  sublabel?: string,
): void {
  try {
    env.ANALYTICS.writeDataPoint({
      blobs: ["auth", "oidc_exchange", event, sublabel ?? ""],
      doubles: [1],
      indexes: ["oidc"],
    });
  } catch {
    // Analytics emission is never load-bearing.
  }
}

export const authOidc = new Hono<AppEnv>();

// POST /exchange -- mounted at /api/auth/oidc -> /api/auth/oidc/exchange.
// Exchange a generic (non-GitHub) OIDC token for a tila session (WI-B2).
authOidc.post("/exchange", async (c) => {
  const ip = c.req.raw.headers.get("CF-Connecting-IP");

  // 1. Rate limit (pre-auth, keyed by IP).
  const limited = await checkExchangeRateLimit(c);
  if (limited) return limited;

  // 2. Parse + validate body.
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

  // 3. Require the session HMAC key (shared with the GitHub flow).
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

  // 4. Resolve the project's OIDC config. Fail closed on a D1 error; a missing
  //    row or unconfigured project both yield "oidc-not-configured" (404) so we
  //    do not disclose project existence.
  let oidcConfig: { issuer: string; audience: string } | null;
  try {
    oidcConfig = await new D1ProjectRegistry(c.env.DB).getOidcConfig(
      project_id,
    );
  } catch (err) {
    console.error("[auth-oidc] project OIDC config lookup failed:", err);
    return c.json(
      {
        ok: false,
        error: {
          code: "oidc-config-unavailable",
          message: "OIDC configuration could not be read",
          retryable: true,
        },
      },
      502,
    );
  }
  if (!oidcConfig) {
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
  const { issuer, audience } = oidcConfig;

  // 5. Resolve the issuer's JWKS URI via OIDC discovery (operator-configured
  //    issuer only; never token-derived).
  let jwksUri: string;
  try {
    jwksUri = await resolveJwksUri(issuer);
  } catch (err) {
    emitDeny(c.env, "issuer_rejected", "discovery");
    await recordExchangeFailure(c.env, ip);
    const message =
      err instanceof OidcDiscoveryError
        ? "OIDC issuer discovery failed"
        : "OIDC issuer could not be resolved";
    return c.json(
      {
        ok: false,
        error: { code: "issuer-discovery-failed", message, retryable: true },
      },
      502,
    );
  }

  // 6. Verify the token against the project-configured issuer + audience.
  let payload: Record<string, unknown>;
  try {
    const result = await verifyOidcJwt(oidc_token, {
      issuer,
      audience,
      jwksUri,
    });
    payload = result.payload;
  } catch (err) {
    if (err instanceof OidcVerificationError) {
      if (err.code === "oidc-jwks-unavailable") {
        emitDeny(c.env, "issuer_rejected", "jwks-empty");
        return c.json(
          {
            ok: false,
            error: {
              code: "jwks-unavailable",
              message: "OIDC signing keys are unavailable",
              retryable: true,
            },
          },
          502,
        );
      }
      emitDeny(c.env, "issuer_rejected", err.code);
      await recordExchangeFailure(c.env, ip);
      return c.json(
        {
          ok: false,
          error: { code: err.code, message: err.message, retryable: false },
        },
        401,
      );
    }
    console.error("[auth-oidc] OIDC verification failed:", err);
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

  // 7. Extract + validate the subject (opaque, capped).
  const subject = payload.sub;
  if (
    typeof subject !== "string" ||
    subject.length === 0 ||
    subject.length > MAX_SUBJECT_LEN
  ) {
    await recordExchangeFailure(c.env, ip);
    return c.json(
      {
        ok: false,
        error: {
          code: "oidc-invalid-token",
          message: "OIDC token has no usable subject",
          retryable: false,
        },
      },
      401,
    );
  }

  // Require a deterministic idempotency key input: a jti, or a numeric iat.
  const jti = typeof payload.jti === "string" ? payload.jti : undefined;
  const iat = typeof payload.iat === "number" ? payload.iat : undefined;
  if (!jti && iat === undefined) {
    await recordExchangeFailure(c.env, ip);
    return c.json(
      {
        ok: false,
        error: {
          code: "oidc-invalid-token",
          message: "OIDC token lacks jti and iat (no replay-safe identity)",
          retryable: false,
        },
      },
      401,
    );
  }

  // 8. Idempotency — distinct namespace + issuer-scoped so it can never collide
  //    with the GitHub `oidc:` flow or survive an issuer reconfiguration.
  const idempotencyKey = `oidc-generic:${project_id}:${issuer}:${jti ?? `${subject}:${iat}`}`;
  const idempotencyStore = new D1IdempotencyStore(c.env.DB);
  const cached = await checkIdempotentExchange(
    idempotencyStore,
    idempotencyKey,
    project_id,
    c.env.DB,
  );
  if (cached) return c.json(cached, 200);

  // 9. Authorize the (project, issuer, subject) principal.
  const principal = await new OidcPrincipalsStore(c.env.DB).isAllowed(
    project_id,
    issuer,
    subject,
  );
  if (!principal) {
    emitDeny(c.env, "principal_not_allowed");
    await recordExchangeFailure(c.env, ip);
    return c.json(
      {
        ok: false,
        error: {
          code: "principal-not-allowed",
          message: "OIDC principal is not registered for this project",
          retryable: false,
        },
      },
      403,
    );
  }

  // 10. Permission — validate against the enum, default to least privilege.
  const permParsed = SessionPermissionSchema.safeParse(principal.permission);
  if (!permParsed.success) {
    console.warn(
      `[auth-oidc] principal ${subject} has an unrecognized permission "${principal.permission}"; defaulting to "read"`,
    );
  }
  const permission = permParsed.success ? permParsed.data : "read";

  // 11. Mint + store.
  let responseBody: Record<string, unknown>;
  try {
    responseBody = await mintAndStoreOidcSession({
      env: c.env,
      hmacKey,
      idempotencyStore,
      idempotencyKey,
      projectId: project_id,
      issuer,
      subject,
      permission,
    });
  } catch (err) {
    console.error("[auth-oidc] session minting failed:", err);
    return c.json(
      {
        ok: false,
        error: {
          code: "mint-failed",
          message: "Failed to mint session token",
          retryable: true,
        },
      },
      500,
    );
  }

  return c.json(responseBody, 200);
});

async function mintAndStoreOidcSession(opts: {
  env: Env;
  hmacKey: string;
  idempotencyStore: D1IdempotencyStore;
  idempotencyKey: string;
  projectId: string;
  issuer: string;
  subject: string;
  permission: "read" | "write" | "admin";
}): Promise<Record<string, unknown>> {
  const {
    env,
    hmacKey,
    idempotencyStore,
    idempotencyKey,
    projectId,
    issuer,
    subject,
    permission,
  } = opts;

  const now = nowSeconds();
  const expiresAt = now + SESSION_TTL_SECONDS;
  const jti = crypto.randomUUID();

  // Best-effort: bind the session to this deployment (B2 replay). A resolver
  // failure leaves instance_id unset (legacy-accepted), never blocking the mint.
  let instanceId: string | undefined;
  try {
    instanceId = await ensureDeploymentInstanceId(env.DB);
  } catch {
    // Non-fatal — minted token simply omits instance_id.
  }

  const payload = {
    sub_type: "oidc" as const,
    project_id: projectId,
    oidc_issuer: issuer,
    oidc_subject: subject,
    actor_name: subject,
    permission,
    expires_at: expiresAt,
    issued_at: now,
    jti,
    ...(instanceId ? { instance_id: instanceId } : {}),
  };

  const sessionToken = await mintSessionToken(payload, hmacKey);

  const responseBody: Record<string, unknown> = {
    ok: true as const,
    session_token: sessionToken,
    expires_at: expiresAt,
    project_id: projectId,
    oidc_issuer: issuer,
    oidc_subject: subject,
    permission,
    ...(instanceId ? { instance_id: instanceId } : {}),
  };

  try {
    await idempotencyStore.store(
      idempotencyKey,
      projectId,
      200,
      JSON.stringify(responseBody),
    );
  } catch {
    // Non-fatal — response is still valid.
  }

  return responseBody;
}
