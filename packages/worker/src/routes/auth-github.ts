import {
  D1IdempotencyStore,
  D1RateLimitStore,
  D1SessionStore,
  D1TokenStore,
  GitHubAppConfigStore,
  RepoAllowlistStore,
} from "@tila/backend-d1";
import {
  GitHubAppExchangeRequestSchema,
  GitHubAppInstallationConfigSchema,
  GitHubExchangeRequestSchema,
  OidcExchangeRequestSchema,
  SessionPermissionSchema,
} from "@tila/schemas";
import { Hono } from "hono";
import { SignJWT, importJWK, jwtVerify } from "jose";
import { z } from "zod";
import {
  RATE_LIMIT_MAX_FAILURES,
  RATE_LIMIT_WINDOW_MS,
  SESSION_TTL_SECONDS,
} from "../config";
import { base64UrlDecode, base64UrlEncode } from "../lib/base64url";
import { buildSessionCookie, isLocalhost } from "../lib/cookie-helpers";
import {
  checkUserMembership,
  getInstallationAccessToken,
  mintAppJwt,
} from "../lib/github-app";
import {
  exchangeOAuthCode,
  getAuthenticatedUser,
  getRepoPermission,
} from "../lib/github-client";
import { hashToken } from "../lib/hash-token";
import { OidcVerificationError, verifyOidcToken } from "../lib/oidc-verify";
import { parseCookieHeader } from "../lib/parse-cookie";
import type { Env, HonoVariables } from "../types";

type AppEnv = { Bindings: Env; Variables: HonoVariables };

const PERMISSION_HIERARCHY: Record<string, number> = {
  none: 0,
  read: 1,
  triage: 2,
  write: 3,
  maintain: 4,
  admin: 5,
};

function permissionMeetsMinimum(actual: string, minimum: string): boolean {
  return (
    (PERMISSION_HIERARCHY[actual] ?? 0) >= (PERMISSION_HIERARCHY[minimum] ?? 0)
  );
}

/**
 * Normalize GitHub permission levels to tila session permission.
 * GitHub returns: none, read, triage, write, maintain, admin
 * Tila sessions use: read, write, admin
 */
function normalizePermission(
  githubPermission: string,
): "read" | "write" | "admin" {
  const level = PERMISSION_HIERARCHY[githubPermission] ?? 0;
  if (level >= PERMISSION_HIERARCHY.admin) return "admin";
  if (level >= PERMISSION_HIERARCHY.write) return "write";
  return "read";
}

/**
 * Mint an HMAC-signed session token using jose.
 * Format: standard JWT (header.payload.signature) with HS256.
 * The token starts with "tila_s." prefix for routing in auth middleware.
 * Full token format: tila_s.<jwtHeader>.<jwtPayload>.<jwtSignature>
 */
async function mintSessionToken(
  payload: Record<string, unknown>,
  hmacKeyRaw: string,
): Promise<string> {
  const keyBytes = base64UrlDecode(hmacKeyRaw);
  const secret = await importJWK(
    { kty: "oct", k: base64UrlEncode(keyBytes), alg: "HS256" },
    "HS256",
  );

  const jwt = await new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer("tila")
    .setAudience("tila")
    .sign(secret);

  return `tila_s.${jwt}`;
}

/**
 * Record an exchange failure to the rate-limit store and emit an analytics
 * data point when the D1 write fails. Extracted from ~4 duplicated call sites.
 *
 * @param env - Worker env bindings (DB + ANALYTICS)
 * @param ip  - Client IP, or null if unknown (no-op when null)
 */
export async function recordExchangeFailure(
  env: { DB: D1Database; ANALYTICS: AnalyticsEngineDataset },
  ip: string | null,
): Promise<void> {
  if (!ip) return;
  const rateLimitStore = new D1RateLimitStore(env.DB);
  try {
    await rateLimitStore.recordFailure(`exchange:${ip}`, RATE_LIMIT_WINDOW_MS);
  } catch {
    // Swallow
    try {
      env.ANALYTICS.writeDataPoint({
        blobs: ["auth", "rate_limit_d1_error", "record_failure"],
        doubles: [1],
        indexes: ["rate-limit"],
      });
    } catch {
      // Analytics emission is never load-bearing
    }
  }
}

/**
 * Check idempotency for an exchange request and handle stale entries.
 * Returns the cached body if valid and unexpired, otherwise null (proceed).
 * Deletes stale entries inline via raw DB call (same pattern as original).
 * Extracted from ~3 duplicated call sites.
 *
 * @param store     - D1IdempotencyStore instance
 * @param key       - Idempotency key to look up
 * @param projectId - Project ID used to scope the check
 * @param db        - D1Database binding (needed for stale-delete)
 * @returns         The cached parsed body object, or null if miss/stale
 */
export async function checkIdempotentExchange(
  store: D1IdempotencyStore,
  key: string,
  projectId: string,
  db: D1Database,
): Promise<Record<string, unknown> | null> {
  const cached = await store.check(key, projectId);
  // If no cached entry, return null immediately
  if (!cached) return null;

  try {
    const cachedBody = JSON.parse(cached.body) as { expires_at?: number };
    if (cachedBody.expires_at && cachedBody.expires_at > Date.now() / 1000) {
      return cachedBody;
    }
    // Stale: delete and re-exchange
    await db.prepare("DELETE FROM _idempotency WHERE key = ?").bind(key).run();
  } catch {
    // Malformed cache entry -- proceed with fresh exchange
  }
  return null;
}

/**
 * Shared tail for exchange flows: normalize permission, mint session token,
 * store idempotency record, and return the response body.
 */
async function mintAndStoreSession(opts: {
  projectId: string;
  matchedRepo: { github_host: string; github_repo_id: number };
  githubUser: { login: string; id: number };
  userPermission: string;
  hmacKey: string;
  idempotencyStore: D1IdempotencyStore;
  idempotencyKey: string;
}): Promise<{ responseBody: Record<string, unknown> }> {
  const {
    projectId,
    matchedRepo,
    githubUser,
    userPermission,
    hmacKey,
    idempotencyStore,
    idempotencyKey,
  } = opts;

  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + SESSION_TTL_SECONDS;
  const normalizedPerm = normalizePermission(userPermission);
  // jti: random nonce for per-token revocation (C9). crypto.randomUUID() is
  // available in the Workers runtime and is cryptographically random.
  const jti = crypto.randomUUID();

  const payload = {
    project_id: projectId,
    github_host: matchedRepo.github_host,
    github_repo_id: matchedRepo.github_repo_id,
    github_login: githubUser.login,
    github_user_id: githubUser.id,
    permission: normalizedPerm,
    expires_at: expiresAt,
    issued_at: now,
    jti,
  };

  const sessionToken = await mintSessionToken(payload, hmacKey);

  const responseBody = {
    ok: true as const,
    session_token: sessionToken,
    expires_at: expiresAt,
    project_id: projectId,
    github_login: githubUser.login,
    github_repo_id: matchedRepo.github_repo_id,
    permission: normalizedPerm,
  };

  try {
    await idempotencyStore.store(
      idempotencyKey,
      projectId,
      200,
      JSON.stringify(responseBody),
    );
  } catch {
    // Non-fatal -- response is still valid
  }

  return { responseBody };
}

/**
 * Handle GitHub App exchange flow (user token → installation token → session token).
 */
async function handleAppExchange(
  c: {
    env: Env;
    req: { raw: { headers: { get: (key: string) => string | null } } };
    json: (data: unknown, status: number) => Response;
  },
  data: { project_id: string; user_token: string },
  ip: string | null,
): Promise<Response> {
  const { project_id, user_token } = data;

  // Check App configuration
  if (!c.env.GITHUB_APP_ID || !c.env.GITHUB_APP_PRIVATE_KEY) {
    console.error("[exchange:app] GitHub App not configured");
    return c.json(
      {
        ok: false,
        error: {
          code: "APP_NOT_CONFIGURED",
          message: "GitHub App is not configured on this server",
          retryable: false,
        },
      },
      500,
    );
  }

  // Check HMAC key is configured
  if (!c.env.GITHUB_SESSION_HMAC_KEY) {
    console.error("[exchange:app] GITHUB_SESSION_HMAC_KEY not configured");
    return c.json(
      {
        ok: false,
        error: {
          code: "HMAC_NOT_CONFIGURED",
          message: "Server configuration error: HMAC signing key not set",
          retryable: false,
        },
      },
      500,
    );
  }

  // Idempotency check (keyed by project_id + sha256 of user token)
  const tokenHash = await hashToken(user_token, c.env.HASH_PEPPER);
  const idempotencyKey = `exchange:${project_id}:${tokenHash}`;
  const idempotencyStore = new D1IdempotencyStore(c.env.DB);

  const cachedBody = await checkIdempotentExchange(
    idempotencyStore,
    idempotencyKey,
    project_id,
    c.env.DB,
  );
  if (cachedBody) {
    return c.json(cachedBody, 200);
  }

  // Authenticate user with GitHub
  let githubUser: { login: string; id: number };
  try {
    githubUser = await getAuthenticatedUser(user_token);
  } catch {
    await recordExchangeFailure(c.env, ip);
    return c.json(
      {
        ok: false,
        error: {
          code: "GITHUB_AUTH_FAILED",
          message: "GitHub authentication failed",
          retryable: false,
        },
      },
      403,
    );
  }

  // Get installation ID for this project
  const configStore = new GitHubAppConfigStore(c.env.DB);
  const installation = await configStore.getInstallation(project_id);

  if (!installation) {
    return c.json(
      {
        ok: false,
        error: {
          code: "APP_NOT_CONFIGURED",
          message: "GitHub App installation not configured for this project",
          retryable: false,
        },
      },
      403,
    );
  }

  // Mint App JWT and get installation access token
  let appJwt: string;
  let installationToken: string;
  try {
    appJwt = await mintAppJwt(
      Number(c.env.GITHUB_APP_ID),
      c.env.GITHUB_APP_PRIVATE_KEY,
    );
    installationToken = await getInstallationAccessToken(
      appJwt,
      installation.installation_id,
    );
  } catch (err) {
    console.error("[exchange:app] Failed to get installation token:", err);
    return c.json(
      {
        ok: false,
        error: {
          code: "GITHUB_API_ERROR",
          message: "Failed to obtain GitHub App installation token",
          retryable: true,
        },
      },
      502,
    );
  }

  // Load allowed repos and check user permissions
  const allowlistStore = new RepoAllowlistStore(c.env.DB);
  const repos = await allowlistStore.listForProject(project_id);

  if (repos.length === 0) {
    return c.json(
      {
        ok: false,
        error: {
          code: "REPO_NOT_ALLOWED",
          message: "No repos registered for this project",
          retryable: false,
        },
      },
      403,
    );
  }

  // Check user's permission on each registered repo via installation token
  let matchedRepo: (typeof repos)[0] | null = null;
  let userPermission: string | null = null;

  for (const repo of repos) {
    const perm = await checkUserMembership(
      installationToken,
      repo.github_owner,
      repo.github_repo,
      githubUser.login,
    );

    if (perm && permissionMeetsMinimum(perm, repo.min_read_permission)) {
      matchedRepo = repo;
      userPermission = perm;
      break;
    }
  }

  if (!matchedRepo || !userPermission) {
    await recordExchangeFailure(c.env, ip);
    return c.json(
      {
        ok: false,
        error: {
          code: "REPO_NOT_ALLOWED",
          message: "Insufficient repository permissions",
          retryable: false,
        },
      },
      403,
    );
  }

  // Mint session token, store idempotency, and build response
  const { responseBody } = await mintAndStoreSession({
    projectId: project_id,
    matchedRepo,
    githubUser,
    userPermission,
    hmacKey: c.env.GITHUB_SESSION_HMAC_KEY,
    idempotencyStore,
    idempotencyKey,
  });

  return c.json(responseBody, 200);
}

export const authGithub = new Hono<AppEnv>();

// POST /exchange -- Exchange GitHub token for tila session
authGithub.post("/exchange", async (c) => {
  // Rate limit check (pre-auth, keyed by IP)
  const ip = c.req.raw.headers.get("CF-Connecting-IP");
  if (ip) {
    const rateLimitStore = new D1RateLimitStore(c.env.DB);
    try {
      const isLimited = await rateLimitStore.check(
        `exchange:${ip}`,
        RATE_LIMIT_MAX_FAILURES,
        RATE_LIMIT_WINDOW_MS,
      );
      if (isLimited) {
        return c.json(
          {
            ok: false,
            error: {
              code: "RATE_LIMITED",
              message: "Too many failed exchange attempts",
              retryable: true,
            },
          },
          429,
        );
      }
    } catch {
      // Fail open
      try {
        c.env.ANALYTICS.writeDataPoint({
          blobs: ["auth", "rate_limit_d1_error", "check"],
          doubles: [1],
          indexes: ["rate-limit"],
        });
      } catch {
        // Analytics emission is never load-bearing
      }
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

  // Content-based dispatch: try App exchange schema first
  const appParsed = GitHubAppExchangeRequestSchema.safeParse(body);
  if (appParsed.success) {
    if (appParsed.data.auth_method === "user_token") {
      return handleAppExchange(c, appParsed.data, ip);
    }
    // OIDC path not yet implemented (deferred to T7)
    return c.json(
      {
        ok: false,
        error: {
          code: "OIDC_NOT_IMPLEMENTED",
          message: "OIDC token exchange is not yet supported",
          retryable: false,
        },
      },
      501,
    );
  }

  // Fall back to legacy PAT exchange
  const parsed = GitHubExchangeRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      {
        ok: false,
        error: {
          code: "VALIDATION_ERROR",
          message: "Invalid request body",
          retryable: false,
        },
      },
      400,
    );
  }

  const { project_id, github_token } = parsed.data;

  // Check HMAC key is configured
  if (!c.env.GITHUB_SESSION_HMAC_KEY) {
    console.error("[exchange] GITHUB_SESSION_HMAC_KEY not configured");
    return c.json(
      {
        ok: false,
        error: {
          code: "HMAC_NOT_CONFIGURED",
          message: "Server configuration error: HMAC signing key not set",
          retryable: false,
        },
      },
      500,
    );
  }

  // Idempotency check (keyed by project_id + sha256 of github token)
  // The hash ensures the raw token is never stored in D1
  const tokenHash = await hashToken(github_token);
  const idempotencyKey = `exchange:${project_id}:${tokenHash}`;
  const idempotencyStore = new D1IdempotencyStore(c.env.DB);

  const cachedBody = await checkIdempotentExchange(
    idempotencyStore,
    idempotencyKey,
    project_id,
    c.env.DB,
  );
  if (cachedBody) {
    return c.json(cachedBody, 200);
  }

  // Authenticate with GitHub
  let githubUser: { login: string; id: number };
  try {
    githubUser = await getAuthenticatedUser(github_token);
  } catch {
    await recordExchangeFailure(c.env, ip);
    return c.json(
      {
        ok: false,
        error: {
          code: "GITHUB_AUTH_FAILED",
          message: "GitHub authentication failed",
          retryable: false,
        },
      },
      403,
    );
  }

  // Find an allowed repo for this project
  const allowlistStore = new RepoAllowlistStore(c.env.DB);
  const repos = await allowlistStore.listForProject(project_id);

  if (repos.length === 0) {
    return c.json(
      {
        ok: false,
        error: {
          code: "REPO_NOT_ALLOWED",
          message: "No repos registered for this project",
          retryable: false,
        },
      },
      403,
    );
  }

  // Check user's permission on each registered repo
  let matchedRepo: (typeof repos)[0] | null = null;
  let userPermission: string | null = null;

  for (const repo of repos) {
    const perm = await getRepoPermission(
      github_token,
      repo.github_owner,
      repo.github_repo,
      githubUser.login,
    );

    if (perm && permissionMeetsMinimum(perm, repo.min_read_permission)) {
      matchedRepo = repo;
      userPermission = perm;
      break;
    }
  }

  if (!matchedRepo || !userPermission) {
    await recordExchangeFailure(c.env, ip);
    return c.json(
      {
        ok: false,
        error: {
          code: "REPO_NOT_ALLOWED",
          message: "Insufficient repository permissions",
          retryable: false,
        },
      },
      403,
    );
  }

  // Mint session token, store idempotency, and build response
  const { responseBody } = await mintAndStoreSession({
    projectId: project_id,
    matchedRepo,
    githubUser,
    userPermission,
    hmacKey: c.env.GITHUB_SESSION_HMAC_KEY,
    idempotencyStore,
    idempotencyKey,
  });

  return c.json(responseBody, 200);
});

// GET /app-info -- Return GitHub App ID and client ID if configured
authGithub.get("/app-info", (c) => {
  const appId = c.env.GITHUB_APP_ID;
  const clientId = c.env.GITHUB_APP_CLIENT_ID;

  if (!appId || !clientId) {
    return c.json(
      {
        ok: false,
        error: {
          code: "APP_NOT_CONFIGURED",
          message: "GitHub App is not configured on this server",
          retryable: false,
        },
      },
      503,
    );
  }

  return c.json(
    {
      ok: true,
      app_id: Number(appId),
      client_id: clientId,
    },
    200,
  );
});

// GET /login -- Redirect to GitHub OAuth authorize URL with HMAC-signed state cookie
authGithub.get("/login", async (c) => {
  const clientId = c.env.GITHUB_APP_CLIENT_ID;
  const hmacKey = c.env.GITHUB_SESSION_HMAC_KEY;

  if (!clientId || !hmacKey) {
    console.error(
      "[login] GITHUB_APP_CLIENT_ID or GITHUB_SESSION_HMAC_KEY not configured",
    );
    return c.json(
      {
        ok: false,
        error: {
          code: "NOT_CONFIGURED",
          message: "GitHub App is not configured on this server",
          retryable: false,
        },
      },
      500,
    );
  }

  // Generate HMAC-signed state using jose
  const nonce = crypto.randomUUID();
  const iat = Math.floor(Date.now() / 1000);

  const keyBytes = base64UrlDecode(hmacKey);
  const secret = await importJWK(
    { kty: "oct", k: base64UrlEncode(keyBytes), alg: "HS256" },
    "HS256",
  );

  const state = await new SignJWT({ nonce, iat })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .sign(secret);

  // Build cookie
  const localDev = isLocalhost(c.req.url);
  const secureFlag = localDev ? "" : " Secure;";
  const stateCookie = `tila_oauth_state=${state}; HttpOnly;${secureFlag} SameSite=Lax; Path=/api/auth/github/oauth/callback; Max-Age=300`;

  // Build redirect URL
  const origin = new URL(c.req.url).origin;
  const redirectUri = `${origin}/api/auth/github/oauth/callback`;
  const authorizeUrl = `https://github.com/login/oauth/authorize?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${encodeURIComponent(state)}`;

  return new Response(null, {
    status: 302,
    headers: {
      Location: authorizeUrl,
      "Set-Cookie": stateCookie,
    },
  });
});

function oauthRedirect(
  status: "success" | "error",
  title: string,
  message: string,
  extraHeaders?: [string, string][],
  uiOrigin?: string,
): Response {
  const params = new URLSearchParams({
    auth_status: status,
    title,
    message,
  });
  const base = uiOrigin ?? "";
  const headers: [string, string][] = [
    ["Location", `${base}/?${params.toString()}`],
    ...(extraHeaders ?? []),
  ];
  return new Response(null, { status: 302, headers });
}

function oauthErrorRedirect(
  title: string,
  message: string,
  uiOrigin?: string,
): Response {
  return oauthRedirect("error", title, message, undefined, uiOrigin);
}

const OAuthStatePayloadSchema = z.object({
  nonce: z.string(),
  iat: z.number().int(),
});

const OAUTH_SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours in ms

// GET /oauth/callback -- Handle GitHub OAuth authorization code callback
authGithub.get("/oauth/callback", async (c) => {
  const { setup_action, code, state } = c.req.query();

  // UI_ORIGIN is a legacy secret for cross-origin Pages deployments. Under same-origin
  // Static Assets deployment it is unset (deleted on provision), and "" yields a
  // same-origin redirect. Kept for backward compatibility with pre-Option-A environments.
  const uiOrigin = c.env.UI_ORIGIN ?? "";

  // Branch: GitHub App installation callback
  if (setup_action) {
    return oauthRedirect(
      "success",
      "GitHub App Installed",
      "You can close this window.",
      undefined,
      uiOrigin,
    );
  }

  // Branch: no meaningful params
  if (!code || !state) {
    return oauthRedirect(
      "success",
      "Done",
      "You can close this window.",
      undefined,
      uiOrigin,
    );
  }

  // Check required config
  const clientId = c.env.GITHUB_APP_CLIENT_ID;
  const clientSecret = c.env.GITHUB_APP_CLIENT_SECRET;
  const hmacKey = c.env.GITHUB_SESSION_HMAC_KEY;

  if (!clientId || !clientSecret || !hmacKey) {
    console.error("[oauth/callback] Required env vars not configured");
    return oauthErrorRedirect(
      "Configuration Error",
      "GitHub OAuth is not configured on this server.",
      uiOrigin,
    );
  }

  // Verify state cookie matches query param
  const cookieHeader = c.req.raw.headers.get("Cookie") ?? undefined;
  const cookieState = parseCookieHeader(cookieHeader, "tila_oauth_state");

  if (!cookieState || cookieState !== state) {
    return oauthErrorRedirect(
      "Invalid State",
      "OAuth state mismatch. Please try logging in again.",
      uiOrigin,
    );
  }

  // Verify and decode state JWT using jose
  let statePayload: z.infer<typeof OAuthStatePayloadSchema>;
  try {
    const keyBytes = base64UrlDecode(hmacKey);
    const secret = await importJWK(
      { kty: "oct", k: base64UrlEncode(keyBytes), alg: "HS256" },
      "HS256",
    );
    const { payload: jwtPayload } = await jwtVerify(state, secret);
    const parsed = OAuthStatePayloadSchema.safeParse(jwtPayload);
    if (!parsed.success) {
      return oauthErrorRedirect(
        "Invalid State",
        "Malformed OAuth state payload.",
        uiOrigin,
      );
    }
    statePayload = parsed.data;
  } catch {
    return oauthErrorRedirect(
      "Invalid State",
      "Failed to verify OAuth state signature.",
      uiOrigin,
    );
  }

  // Check state expiry (iat is seconds)
  const now = Math.floor(Date.now() / 1000);
  if (now - statePayload.iat > 300) {
    return oauthErrorRedirect(
      "Expired State",
      "OAuth login session has expired. Please try again.",
      uiOrigin,
    );
  }

  // Exchange code for access token
  const origin = new URL(c.req.url).origin;
  const redirectUri = `${origin}/api/auth/github/oauth/callback`;

  let accessToken: string;
  try {
    const result = await exchangeOAuthCode(
      clientId,
      clientSecret,
      code,
      redirectUri,
    );
    accessToken = result.accessToken;
  } catch {
    return oauthErrorRedirect(
      "Authentication Failed",
      "Failed to complete GitHub OAuth. Please try again.",
      uiOrigin,
    );
  }

  // Get user identity
  let user: { login: string; id: number };
  try {
    user = await getAuthenticatedUser(accessToken);
  } catch {
    // Discard accessToken — never persisted
    return oauthErrorRedirect(
      "Authentication Failed",
      "Failed to retrieve GitHub user identity. Please try again.",
      uiOrigin,
    );
  }

  // Discard accessToken immediately — never store, persist, or forward
  // (variable goes out of scope after this point)

  // Create workspace session in D1
  const sessionToken = crypto.randomUUID();
  const sessionHash = await hashToken(sessionToken);
  const expiresAt = Date.now() + OAUTH_SESSION_TTL_MS;

  const sessionStore = new D1SessionStore(c.env.DB);
  try {
    await sessionStore.create({
      sessionHash,
      projectId: "",
      tokenHash: "",
      actorName: user.login,
      scopes: "",
      expiresAt,
    });
  } catch (err) {
    console.error("[oauth/callback] Failed to create session:", err);
    return oauthErrorRedirect(
      "Session Error",
      "Failed to create login session. Please try again.",
      uiOrigin,
    );
  }

  // Build cookies
  const localDev = isLocalhost(c.req.url);
  const sessionCookie = buildSessionCookie(sessionToken, localDev);
  const clearStateCookie =
    "tila_oauth_state=; HttpOnly; SameSite=Lax; Path=/api/auth/github/oauth/callback; Max-Age=0";

  // Redirect to UI (same-origin by default; uiOrigin is "" unless the legacy
  // UI_ORIGIN secret is still set from a pre-Option-A environment)
  return new Response(null, {
    status: 302,
    headers: [
      ["Location", `${uiOrigin}/`],
      ["Set-Cookie", sessionCookie],
      ["Set-Cookie", clearStateCookie],
    ],
  });
});

// POST /app-config -- Store GitHub App installation ID for a project
authGithub.post("/app-config", async (c) => {
  // Inline token auth check (this route is on the pre-auth router)
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json(
      {
        ok: false,
        error: {
          code: "UNAUTHORIZED",
          message: "Missing or invalid Authorization header",
          retryable: false,
        },
      },
      401,
    );
  }

  const rawToken = authHeader.slice("Bearer ".length);
  const tokenHash = await hashToken(rawToken);

  const tokenStore = new D1TokenStore(c.env.DB);
  const tokenResult = await tokenStore.validate(tokenHash);

  if (!tokenResult) {
    return c.json(
      {
        ok: false,
        error: {
          code: "UNAUTHORIZED",
          message: "Invalid or revoked token",
          retryable: false,
        },
      },
      401,
    );
  }

  // Verify token has full scope (admin-level access)
  if (tokenResult.scopes !== "full") {
    return c.json(
      {
        ok: false,
        error: {
          code: "FORBIDDEN",
          message: "This operation requires full token scope",
          retryable: false,
        },
      },
      403,
    );
  }

  // Update token last_used_at
  try {
    await tokenStore.updateLastUsedAt(tokenHash);
  } catch {
    // Non-fatal
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

  const parsed = GitHubAppInstallationConfigSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      {
        ok: false,
        error: {
          code: "VALIDATION_ERROR",
          message: "Invalid request body",
          retryable: false,
        },
      },
      400,
    );
  }

  const { installation_id } = parsed.data;
  const project_id = tokenResult.projectId;

  // Store installation config in D1
  const configStore = new GitHubAppConfigStore(c.env.DB);
  await configStore.setInstallation(
    project_id,
    installation_id,
    tokenResult.name,
  );

  return c.json(
    {
      ok: true,
      installation_id,
      project_id,
    },
    200,
  );
});

// POST /exchange-oidc -- Exchange GitHub Actions OIDC JWT for tila session
authGithub.post("/exchange-oidc", async (c) => {
  // Rate limit check (pre-auth, keyed by IP)
  const ip = c.req.raw.headers.get("CF-Connecting-IP");
  if (ip) {
    const rateLimitStore = new D1RateLimitStore(c.env.DB);
    try {
      const isLimited = await rateLimitStore.check(
        `exchange:${ip}`,
        RATE_LIMIT_MAX_FAILURES,
        RATE_LIMIT_WINDOW_MS,
      );
      if (isLimited) {
        return c.json(
          {
            ok: false,
            error: {
              code: "RATE_LIMITED",
              message: "Too many failed exchange attempts",
              retryable: true,
            },
          },
          429,
        );
      }
    } catch {
      // Fail open
      try {
        c.env.ANALYTICS.writeDataPoint({
          blobs: ["auth", "rate_limit_d1_error", "check"],
          doubles: [1],
          indexes: ["rate-limit"],
        });
      } catch {
        // Analytics emission is never load-bearing
      }
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

  const parsed = OidcExchangeRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      {
        ok: false,
        error: {
          code: "VALIDATION_ERROR",
          message: "Invalid request body",
          retryable: false,
        },
      },
      400,
    );
  }

  const { project_id, oidc_token } = parsed.data;

  // Check OIDC audience is configured
  if (!c.env.GITHUB_OIDC_AUDIENCE) {
    console.error("[exchange-oidc] GITHUB_OIDC_AUDIENCE not configured");
    return c.json(
      {
        ok: false,
        error: {
          code: "OIDC_NOT_CONFIGURED",
          message: "Server configuration error: OIDC audience not set",
          retryable: false,
        },
      },
      500,
    );
  }

  // Check HMAC key is configured
  if (!c.env.GITHUB_SESSION_HMAC_KEY) {
    console.error("[exchange-oidc] GITHUB_SESSION_HMAC_KEY not configured");
    return c.json(
      {
        ok: false,
        error: {
          code: "HMAC_NOT_CONFIGURED",
          message: "Server configuration error: HMAC signing key not set",
          retryable: false,
        },
      },
      500,
    );
  }

  // Verify OIDC token
  let claims: Awaited<ReturnType<typeof verifyOidcToken>>;
  try {
    claims = await verifyOidcToken(oidc_token, c.env.GITHUB_OIDC_AUDIENCE);
  } catch (err) {
    // Map OIDC verification errors to HTTP status codes
    if (err instanceof OidcVerificationError) {
      const statusCode = err.code === "OIDC_JWKS_UNAVAILABLE" ? 502 : 401;

      // Record rate-limit failure for auth errors
      if (statusCode === 401) {
        await recordExchangeFailure(c.env, ip);
      }

      return c.json(
        {
          ok: false,
          error: {
            code: err.code,
            message: err.message,
            retryable: statusCode === 502,
          },
        },
        statusCode,
      );
    }
    // Unknown error
    console.error("[exchange-oidc] OIDC verification failed:", err);
    return c.json(
      {
        ok: false,
        error: {
          code: "OIDC_INVALID_TOKEN",
          message: "OIDC token verification failed",
          retryable: false,
        },
      },
      401,
    );
  }

  // Idempotency check (keyed by project_id + jti from verified claims)
  const idempotencyKey = `oidc:${project_id}:${claims.jti}`;
  const idempotencyStore = new D1IdempotencyStore(c.env.DB);

  const cachedOidcBody = await checkIdempotentExchange(
    idempotencyStore,
    idempotencyKey,
    project_id,
    c.env.DB,
  );
  if (cachedOidcBody) {
    return c.json(cachedOidcBody, 200);
  }

  // Check if repo is registered for this project
  const allowlistStore = new RepoAllowlistStore(c.env.DB);
  const repo = await allowlistStore.isRegistered(
    project_id,
    "github.com",
    claims.repository_id,
  );

  if (!repo) {
    await recordExchangeFailure(c.env, ip);
    return c.json(
      {
        ok: false,
        error: {
          code: "REPO_NOT_ALLOWED",
          message: "Repository not registered for this project",
          retryable: false,
        },
      },
      403,
    );
  }

  // Read oidc_permission from allowlist and validate it
  const oidcPermissionParsed = SessionPermissionSchema.safeParse(
    repo.oidc_permission,
  );
  if (!oidcPermissionParsed.success) {
    console.warn(
      `[auth-oidc] repo ${claims.repository_id} has an unrecognized oidc_permission value "${repo.oidc_permission}"; defaulting to "read" (least privilege)`,
    );
  }
  const oidcPermission = oidcPermissionParsed.success
    ? oidcPermissionParsed.data
    : "read"; // Default to read (least privilege) if invalid

  // Route through mintAndStoreSession for field-parity with other exchange flows.
  // The OIDC "user" is the GitHub Actions actor; the matched "repo" mirrors the
  // shape expected by mintAndStoreSession.
  const { responseBody } = await mintAndStoreSession({
    projectId: project_id,
    matchedRepo: {
      github_host: "github.com",
      github_repo_id: claims.repository_id,
    },
    githubUser: {
      login: claims.actor,
      id: claims.actor_id,
    },
    userPermission: oidcPermission,
    hmacKey: c.env.GITHUB_SESSION_HMAC_KEY,
    idempotencyStore,
    idempotencyKey,
  });

  return c.json(responseBody, 200);
});
