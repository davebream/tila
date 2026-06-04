import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface SessionCache {
  session_token: string;
  expires_at: number;
  project_id: string;
}

const SESSION_FILENAME = ".session";
const PROACTIVE_REFRESH_SECONDS = 600; // 10 minutes

/**
 * Read cached session from tilaDir/.session.
 * Returns null if missing, expired, or within proactive refresh window.
 */
function readSessionCache(tilaDir: string): SessionCache | null {
  const sessionPath = join(tilaDir, SESSION_FILENAME);
  if (!existsSync(sessionPath)) {
    return null;
  }

  try {
    const content = readFileSync(sessionPath, "utf-8");
    const cached = JSON.parse(content) as SessionCache;
    const now = Date.now() / 1000;

    // Proactive refresh: treat session as expired if within 10min of expiry
    if (cached.expires_at - now < PROACTIVE_REFRESH_SECONDS) {
      return null;
    }

    return cached;
  } catch {
    return null;
  }
}

/**
 * Write session cache to tilaDir/.session with restrictive permissions.
 * Non-fatal: falls back to in-memory session if write fails.
 */
function writeSessionCache(tilaDir: string, session: SessionCache): void {
  const sessionPath = join(tilaDir, SESSION_FILENAME);
  try {
    writeFileSync(sessionPath, JSON.stringify(session), {
      mode: 0o600,
      encoding: "utf-8",
    });
  } catch {
    // Non-fatal: continue with in-memory session
    console.warn("Warning: Could not write session cache to", sessionPath);
  }
}

/**
 * Resolve a tila session token via GitHub Actions OIDC.
 * Called automatically when ACTIONS_ID_TOKEN_REQUEST_URL is detected.
 */
async function resolveOidcToken(
  config: { project_id: string; worker_url: string },
  tilaDir: string,
): Promise<string> {
  const requestUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;

  if (!requestUrl || !requestToken) {
    throw new Error(
      "ACTIONS_ID_TOKEN_REQUEST_URL and ACTIONS_ID_TOKEN_REQUEST_TOKEN must be set",
    );
  }

  // Audience must match the Worker's GITHUB_OIDC_AUDIENCE secret exactly.
  const audience = config.worker_url;

  const tokenRes = await fetch(
    `${requestUrl}&audience=${encodeURIComponent(audience)}`,
    {
      headers: { Authorization: `bearer ${requestToken}` },
    },
  );

  if (!tokenRes.ok) {
    throw new Error(
      `Failed to request OIDC token from GitHub (${tokenRes.status})`,
    );
  }

  const { value: oidcToken } = (await tokenRes.json()) as { value: string };

  // Exchange OIDC token for tila session
  const exchangeUrl = `${config.worker_url}/api/auth/github/exchange-oidc`;
  const res = await fetch(exchangeUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      project_id: config.project_id,
      oidc_token: oidcToken,
    }),
  });

  if (!res.ok) {
    let detail = "";
    try {
      const errBody = (await res.json()) as { error?: { message?: string } };
      detail = errBody?.error?.message ?? "";
    } catch {
      // ignore
    }
    throw new Error(`OIDC token exchange failed (${res.status}).\n${detail}`);
  }

  const body = (await res.json()) as {
    session_token: string;
    expires_at: number;
    project_id: string;
  };

  writeSessionCache(tilaDir, {
    session_token: body.session_token,
    expires_at: body.expires_at,
    project_id: body.project_id,
  });

  return body.session_token;
}

/**
 * Create a token provider function for github-repo auth mode.
 *
 * The returned function resolves a tila session token using:
 * 1. Session cache (proactive refresh at TTL-10min)
 * 2. OIDC exchange (when running in GitHub Actions)
 * 3. Error with actionable message (no interactive device flow in MCP server)
 *
 * The MCP server runs as a stdio subprocess and cannot perform interactive
 * terminal prompts. Users must run `tila auth login` first to populate the
 * session cache.
 */
export function createGithubTokenProvider(
  config: { project_id: string; worker_url: string },
  tilaDir: string,
): () => Promise<string> {
  return async (): Promise<string> => {
    // 1. Check session cache
    const cached = readSessionCache(tilaDir);
    if (cached && cached.project_id === config.project_id) {
      return cached.session_token;
    }

    // 2. Detect GitHub Actions OIDC environment
    if (
      process.env.ACTIONS_ID_TOKEN_REQUEST_URL &&
      process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN
    ) {
      return resolveOidcToken(config, tilaDir);
    }

    // 3. No session and no OIDC — throw with actionable error
    throw new Error(
      "No valid GitHub session. Run `tila auth login` to authenticate.",
    );
  };
}
