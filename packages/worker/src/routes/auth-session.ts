import {
  D1RateLimitStore,
  D1SessionStore,
  D1TokenStore,
} from "@tila/backend-d1";
import { SessionExchangeRequestSchema } from "@tila/schemas";
import { Hono } from "hono";
import { COOKIE_SESSION_TTL_SECONDS } from "../config";
import { buildSessionCookie, isLocalhost } from "../lib/cookie-helpers";
import { hashToken } from "../lib/hash-token";
import { invalidateSession } from "../lib/session-cache";
import type { Env, HonoVariables } from "../types";

type AppEnv = { Bindings: Env; Variables: HonoVariables };

const COOKIE_SESSION_TTL_MS = COOKIE_SESSION_TTL_SECONDS * 1000;
const RATE_LIMIT_MAX_FAILURES = 20;
const RATE_LIMIT_WINDOW_MS = 60_000;

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

authSessionExchange.post("/", async (c) => {
  const ip = c.req.header("CF-Connecting-IP");

  // Rate limit check
  if (ip) {
    const rateLimitStore = new D1RateLimitStore(c.env.DB);
    try {
      const isLimited = await rateLimitStore.check(
        ip,
        RATE_LIMIT_MAX_FAILURES,
        RATE_LIMIT_WINDOW_MS,
      );
      if (isLimited) {
        return c.json(
          {
            ok: false,
            error: {
              code: "RATE_LIMITED",
              message: "Too many requests",
              retryable: true,
            },
          },
          429,
        );
      }
    } catch {
      // Fail open on transient D1 error
    }
  }

  // Parse and validate body
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

  const parsed = SessionExchangeRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      {
        ok: false,
        error: {
          code: "VALIDATION_ERROR",
          message: "Missing required fields: token, project_id",
          retryable: false,
        },
      },
      400,
    );
  }

  const { token, project_id } = parsed.data;

  // Validate token against D1 (SEC-1: pepper to match D1-token mint in tokens.ts)
  const tokenHash = await hashToken(token, c.env.HASH_PEPPER);
  const tokenStore = new D1TokenStore(c.env.DB);
  const tokenResult = await tokenStore.validate(tokenHash);

  if (!tokenResult) {
    // Increment rate limit on failure
    if (ip) {
      const rateLimitStore = new D1RateLimitStore(c.env.DB);
      try {
        await rateLimitStore.recordFailure(ip, RATE_LIMIT_WINDOW_MS);
      } catch {
        // Non-fatal
      }
    }
    return c.json(
      {
        ok: false,
        error: {
          code: "UNAUTHORIZED",
          message: "Invalid token",
          retryable: false,
        },
      },
      401,
    );
  }

  // Verify token belongs to the requested project
  if (tokenResult.projectId !== project_id) {
    return c.json(
      {
        ok: false,
        error: {
          code: "UNAUTHORIZED",
          message: "Token not authorized for this project",
          retryable: false,
        },
      },
      401,
    );
  }

  // Create session (SEC-1: pepper to match the cookie-session lookup in auth.ts:302)
  const sessionUUID = crypto.randomUUID();
  const sessionHash = await hashToken(sessionUUID, c.env.HASH_PEPPER);
  const expiresAt = Date.now() + COOKIE_SESSION_TTL_MS;

  const sessionStore = new D1SessionStore(c.env.DB);
  try {
    await sessionStore.create({
      sessionHash,
      projectId: project_id,
      tokenHash,
      actorName: tokenResult.name,
      scopes: tokenResult.scopes,
      expiresAt,
    });
  } catch (err) {
    console.error("[auth-session] session create failed:", err);
    return c.json(
      {
        ok: false,
        error: {
          code: "INTERNAL_ERROR",
          message: "Session creation failed",
          retryable: true,
        },
      },
      500,
    );
  }

  // Set httpOnly cookie (omit Secure on localhost for local dev)
  c.header(
    "Set-Cookie",
    buildSessionCookie(sessionUUID, isLocalhost(c.req.url)),
  );

  return c.json({ ok: true });
});

// Auth-protected session routes (require auth middleware upstream)
export const authSessionProtected = new Hono<AppEnv>();

// POST /auth/logout — clear cookie and revoke session
authSessionProtected.post("/logout", async (c) => {
  const sessionCookie = parseCookieValue(
    c.req.header("Cookie"),
    "tila_session",
  );
  if (sessionCookie) {
    // SEC-1: pepper to match the session mint above and the cookie lookup in auth.ts:302
    const sessionHash = await hashToken(sessionCookie, c.env.HASH_PEPPER);
    const sessionStore = new D1SessionStore(c.env.DB);
    try {
      await sessionStore.revoke(sessionHash);
    } catch (err) {
      console.error("[auth-session] session revoke failed:", err);
      // Log error but still clear cookie (idempotent logout)
    }
    // Always invalidate session cache regardless of D1 result
    invalidateSession(sessionHash);
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

// GET /auth/session/status — return current session info
authSessionProtected.get("/status", (c) => {
  const tokenResult = c.get("tokenResult");
  return c.json({ ok: true, projectId: tokenResult.projectId });
});
