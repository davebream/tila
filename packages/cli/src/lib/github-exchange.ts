import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as p from "@clack/prompts";
import { resolveAppUserToken } from "./github-oauth-device";

interface SessionCache {
  session_token: string;
  expires_at: number;
  project_id: string;
}

const SESSION_FILENAME = ".session";
const PROACTIVE_REFRESH_SECONDS = 600; // 10 minutes

/**
 * Read cached session from .tila/.session.
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

    // Proactive refresh: re-exchange if within 10min of expiry
    if (cached.expires_at - now < PROACTIVE_REFRESH_SECONDS) {
      return null;
    }

    return cached;
  } catch {
    return null;
  }
}

/**
 * Write session cache to .tila/.session with restrictive permissions.
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
    // Non-fatal: warn but continue with in-memory session
    p.log.warn(`Warning: Could not write session cache to ${sessionPath}`);
  }
}

/**
 * Warn to stderr if the git remote origin owner/repo does not match
 * config.github.owner/repo. Non-fatal -- UX signal only.
 */
export function warnIfRemoteMismatch(
  config: { github?: { host?: string; owner?: string; repo?: string } },
  cwd: string,
): void {
  if (!config.github?.owner || !config.github?.repo) return;
  try {
    const remoteUrl = execSync(
      `git -C ${JSON.stringify(cwd)} remote get-url origin`,
      { encoding: "utf-8", timeout: 3000, stdio: ["pipe", "pipe", "pipe"] },
    ).trim();
    const match = remoteUrl.match(
      /(?:https?:\/\/[^/]+\/|git@[^:]+:)([^/]+)\/([^/.]+)(?:\.git)?$/,
    );
    if (!match) return;
    const [, remoteOwner, remoteRepo] = match;
    if (
      remoteOwner.toLowerCase() !== config.github.owner.toLowerCase() ||
      remoteRepo.toLowerCase() !== config.github.repo.toLowerCase()
    ) {
      p.log.warn(
        `Warning: git remote origin (${remoteOwner}/${remoteRepo}) does not match config.github (${config.github.owner}/${config.github.repo}).\n  If this is intentional, update [github] in .tila/config.toml.`,
      );
    }
  } catch {
    // Non-fatal: not a git repo, no remote, or timeout -- silently skip
  }
}

/**
 * Resolve a tila session token via GitHub Actions OIDC.
 * Called automatically when ACTIONS_ID_TOKEN_REQUEST_URL is detected.
 *
 * 1. Request OIDC token from GitHub's token endpoint
 * 2. Exchange OIDC token for tila session
 * 3. Cache and return
 */
async function resolveOidcToken(
  config: { project_id: string; worker_url: string },
  tilaDir: string,
): Promise<string> {
  // 1. Request OIDC token from GitHub's token endpoint
  const requestUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;

  if (!requestUrl || !requestToken) {
    throw new Error(
      "ACTIONS_ID_TOKEN_REQUEST_URL and ACTIONS_ID_TOKEN_REQUEST_TOKEN must be set",
    );
  }

  // Audience must match the Worker's GITHUB_OIDC_AUDIENCE secret exactly.
  // Default to worker_url — the admin must set GITHUB_OIDC_AUDIENCE to this same value.
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

  // 2. Exchange OIDC token for tila session
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

  // 3. Cache session
  writeSessionCache(tilaDir, {
    session_token: body.session_token,
    expires_at: body.expires_at,
    project_id: body.project_id,
  });

  return body.session_token;
}

/**
 * Resolve a tila session token via GitHub-repo auth mode.
 * 1. Check session cache (proactive refresh at TTL-10min)
 * 2a. If in GitHub Actions environment, use OIDC flow (auto-detected)
 * 2b. Otherwise, resolve GitHub user token (cache → env → device flow via resolveAppUserToken)
 * 3. Exchange for tila session using auth_method: "user_token"
 * 4. Cache and return
 *
 * The raw GitHub token is NEVER written to disk or logged.
 */
export async function resolveGithubRepoToken(
  config: {
    project_id: string;
    worker_url: string;
    github?: { host?: string; owner?: string; repo?: string; repo_id?: number };
  },
  tilaDir: string,
): Promise<string> {
  // 1. Check cache
  const cached = readSessionCache(tilaDir);
  if (cached && cached.project_id === config.project_id) {
    return cached.session_token;
  }

  // 2a. Detect GitHub Actions OIDC environment
  if (
    process.env.ACTIONS_ID_TOKEN_REQUEST_URL &&
    process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN
  ) {
    return resolveOidcToken(config, tilaDir);
  }

  // 2b. Resolve GitHub user token via App OAuth device flow
  const userToken = await resolveAppUserToken(
    { project_id: config.project_id, worker_url: config.worker_url },
    tilaDir,
  );

  // 3. Exchange using App OAuth format
  const exchangeUrl = `${config.worker_url}/api/auth/github/exchange`;
  const res = await fetch(exchangeUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      auth_method: "user_token",
      project_id: config.project_id,
      user_token: userToken,
    }),
  });

  if (!res.ok) {
    let detail = "";
    let errorCode = "";
    try {
      const errBody = (await res.json()) as {
        error?: { message?: string; code?: string };
      };
      detail = errBody?.error?.message ?? "";
      errorCode = errBody?.error?.code ?? "";
    } catch {
      // ignore
    }

    if (res.status === 403) {
      throw new Error(
        `GitHub repo is not registered for this tila project.\n${detail}\n\nAsk a project admin to register your repo by running: tila repos register`,
      );
    }

    if (errorCode === "HMAC_NOT_CONFIGURED") {
      throw new Error(
        "HMAC signing key not configured on the tila Worker.\n\nAn admin must set the GITHUB_SESSION_HMAC_KEY secret:\n  npx wrangler secret put GITHUB_SESSION_HMAC_KEY\n\nGenerate a 32-byte base64url key:\n  openssl rand -base64 32",
      );
    }

    throw new Error(`Token exchange failed (${res.status}).\n${detail}`);
  }

  const body = (await res.json()) as {
    session_token: string;
    expires_at: number;
    project_id: string;
  };

  // 4. Cache
  const session: SessionCache = {
    session_token: body.session_token,
    expires_at: body.expires_at,
    project_id: body.project_id,
  };
  writeSessionCache(tilaDir, session);

  return body.session_token;
}
