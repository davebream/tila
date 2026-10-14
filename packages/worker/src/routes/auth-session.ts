import { SessionExchangeRequestSchema } from "@tila/schemas";
import { Hono } from "hono";
import { COOKIE_SESSION_TTL_SECONDS } from "../config";
import { CredentialStore, SCOPED_TOKEN_MARKER } from "../d1";
import { D1SessionStore, D1TokenStore } from "../d1";
import { revokeSession } from "../lib/admin-ops";
import { buildSessionCookie, isLocalhost } from "../lib/cookie-helpers";
import { hashToken } from "../lib/hash-token";
import { accountAuth, humanHeaders } from "../lib/human-auth";
import { invalidateSession } from "../lib/session-cache";
import { invalidate } from "../lib/token-cache";
import { csrfGuard } from "../middleware/csrf";
import { computeSessionCapabilities } from "../middleware/session-capabilities";
import type { Env, HonoVariables, UnifiedTokenResult } from "../types";
import { checkExchangeRateLimit, recordExchangeFailure } from "./auth-github";

type AppEnv = { Bindings: Env; Variables: HonoVariables };

const COOKIE_SESSION_TTL_MS = COOKIE_SESSION_TTL_SECONDS * 1000;

function parseCookieValue(
  header: string | undefined,
  name: string,
): string | null {
  if (!header) return null;
  const pairs = header.split(";").map((s) => s.trim());
  for (const pair of pairs) {
    const eqIdx = pair.indexOf("=");
    if (eqIdx === -1) continue;
    if (pair.slice(0, eqIdx).trim() === name) {
      return decodeURIComponent(pair.slice(eqIdx + 1).trim());
    }
  }
  return null;
}

// POST /auth/session — pre-auth session exchange endpoint
export const authSessionExchange = new Hono<AppEnv>();

authSessionExchange.post("/", (c) =>
  c.json(
    {
      ok: false,
      error: {
        code: "token-login-retired",
        message:
          "API tokens cannot create browser sessions. Sign in with an account that has project membership, or ask your administrator for an invitation with project access. For first administrator setup, the infrastructure owner can run tila auth setup with --url, --email, and --project. Use tila login for CLI account access.",
        retryable: false,
      },
    },
    410,
  ),
);

authSessionExchange.onError((_error, c) =>
  c.json(
    {
      ok: false,
      error: {
        code: "auth-unavailable",
        message: "Authentication temporarily unavailable",
        retryable: true,
      },
    },
    503,
  ),
);

// Auth-protected session routes (require auth middleware upstream)
export const authSessionProtected = new Hono<AppEnv>();

// POST /auth/logout — self-service: revoke the caller's OWN credential (WI-D).
// Branches on the authenticated token kind:
//   - session (bearer JWT): revoke own jti (+ jti cache) — legacy no-jti → no-op
//   - d1-token:             revoke own API token (+ token cache + session cascade)
//   - cookie-session:       revoke session hash (+ session cache) — unchanged path
//   - workspace-session:    no-op
// Always clears the cookie and returns { ok: true }; idempotent (double-logout safe).
authSessionProtected.post("/logout", csrfGuard, async (c) => {
  if (c.get("humanSession"))
    return (await accountAuth(c)).api.signOut({
      headers: humanHeaders(c.req.raw.headers),
      asResponse: true,
    });
  // WI-I: check-only shared rate-limit guard (defense-in-depth). Rejects an IP
  // already over the exchange:${ip} threshold; never records a failure, so a
  // legitimate logout is never counted toward the brute-force budget.
  const limited = await checkExchangeRateLimit(c);
  if (limited) return limited;

  const tokenResult = c.get("tokenResult");

  switch (tokenResult.kind) {
    case "github-actions-session":
    case "session": {
      // Bearer session JWT — revoke its jti so the verifier denies it (C9).
      if (tokenResult.jti) {
        try {
          await revokeSession(c.env, tokenResult.jti, tokenResult.projectId);
        } catch (err) {
          console.error("[auth-session] jti revoke failed:", err);
        }
      }
      break;
    }
    case "d1-token": {
      if (tokenResult.policy && tokenResult.principalId) {
        try {
          await new CredentialStore(
            c.env.DB,
            c.env.GITHUB_ACTIONS_TRUSTED_ISSUERS,
          ).revoke(tokenResult.projectId, tokenResult.name, {
            principalId: tokenResult.principalId,
            tokenId: tokenResult.tokenId,
          });
        } catch {
          return c.json(
            {
              ok: false,
              error: {
                code: "credential-unavailable",
                message: "Could not revoke credential; retry logout",
                retryable: true,
              },
            },
            503,
          );
        }
        break;
      }
      // Self-service revoke of the caller's own durable D1 API token.
      try {
        const tokenStore = new D1TokenStore(c.env.DB);
        const { tokenHash } = await tokenStore.revoke(
          tokenResult.projectId,
          tokenResult.name,
          "self-logout",
        );
        if (tokenHash) {
          invalidate(tokenHash);
          try {
            await new D1SessionStore(c.env.DB).deleteByTokenHash(tokenHash);
          } catch (err) {
            console.error("[auth-session] d1-token session cascade failed:");
          }
        }
      } catch (err) {
        console.error("[auth-session] d1-token revoke failed");
      }
      break;
    }
    case "cookie-session": {
      // Existing cookie path — derive the peppered hash from the raw cookie
      // (SEC-1; must match the mint pepper and auth.ts cookie lookup). Do NOT
      // substitute tokenResult.sessionHash.
      const sessionCookie = parseCookieValue(
        c.req.header("Cookie"),
        "tila_session",
      );
      if (sessionCookie) {
        const sessionHash = await hashToken(sessionCookie, c.env.HASH_PEPPER);
        const sessionStore = new D1SessionStore(c.env.DB);
        try {
          await sessionStore.revoke(sessionHash);
        } catch (err) {
          console.error("[auth-session] session revoke failed");
          // Log error but still clear cookie (idempotent logout)
        }
        // Always invalidate session cache regardless of D1 result
        invalidateSession(sessionHash);
      }
      break;
    }
    // workspace-session (and any future kind): no revocation primitive — no-op.
  }

  // Clear cookie regardless of session state — must match buildSessionCookie SameSite logic.
  // Under same-origin deployment SameSite=Lax is the CSRF mechanism; use Lax here too.
  const isLocalDev = isLocalhost(c.req.url);
  const clearCookie = isLocalDev
    ? "tila_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0"
    : "tila_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0";
  c.header("Set-Cookie", clearCookie);
  return c.json({ ok: true });
});

function effectivePermission(
  tokenResult: UnifiedTokenResult,
): "read" | "write" | "admin" | "none" {
  switch (tokenResult.kind) {
    case "session":
    case "cookie-session":
    case "oidc-session":
    case "github-actions-session":
      return tokenResult.permission as "read" | "write" | "admin";
    case "d1-token":
      return tokenResult.scopes === "full" ? "admin" : "read";
    case "workspace-session":
      return "none";
    default: {
      const _exhaustive: never = tokenResult;
      return "none";
    }
  }
}

function canManageTokens(tokenResult: UnifiedTokenResult): boolean {
  if (
    (tokenResult.kind === "d1-token" ||
      tokenResult.kind === "cookie-session") &&
    tokenResult.policy
  )
    return (
      tokenResult.policy.role === "owner" &&
      tokenResult.policy.capabilities.includes("tokens:read")
    );
  return effectivePermission(tokenResult) === "admin";
}

// GET /auth/session/status — return current session info.
// `permission` and `canManageTokens` are legacy snapshots kept for
// compatibility; management UI must gate on `capabilities` (#102).
authSessionProtected.get("/status", async (c) => {
  const tokenResult = c.get("tokenResult");
  const permission = effectivePermission(tokenResult);
  return c.json({
    ok: true,
    projectId: tokenResult.projectId,
    permission,
    canManageTokens: canManageTokens(tokenResult),
    capabilities: await computeSessionCapabilities(c),
  });
});
