import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as p from "@clack/prompts";
import { GitHubAppInfoResponseSchema } from "@tila/schemas";
import { openInBrowser } from "./browser";

/**
 * Response from GitHub device flow initiation.
 */
interface DeviceFlowResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  interval: number;
}

/**
 * Cached token state.
 */
interface TokenCacheEntry {
  user_token: string;
  expires_at: number;
  project_id: string;
}

/**
 * Configuration object for resolveAppUserToken.
 */
interface AppUserTokenConfig {
  project_id: string;
  worker_url: string;
}

/**
 * Fetch GitHub App client_id from Worker endpoint or local config.
 * Tries Worker endpoint first, falls back to .tila/github-app.json.
 *
 * @param workerUrl - The tila Worker base URL
 * @param tilaDir - Path to .tila directory
 * @returns GitHub App client_id
 */
export async function fetchClientId(
  workerUrl: string,
  tilaDir: string,
): Promise<string> {
  // Try Worker endpoint first
  try {
    const response = await fetch(`${workerUrl}/api/auth/github/app-info`);
    if (response.ok) {
      const json = await response.json();
      const parsed = GitHubAppInfoResponseSchema.parse(json);
      return parsed.client_id;
    }
    // If response is not ok, fall through to local config fallback
  } catch (error) {
    // Fall back to local config on any error
  }

  // Fallback to .tila/github-app.json
  const configPath = join(tilaDir, "github-app.json");
  if (!existsSync(configPath)) {
    throw new Error(
      "GitHub App not configured. Run setup first or check Worker endpoint.",
    );
  }

  try {
    const configContent = readFileSync(configPath, "utf-8");
    const config = JSON.parse(configContent);
    if (!config.client_id || typeof config.client_id !== "string") {
      throw new Error("Invalid github-app.json: missing client_id");
    }
    return config.client_id;
  } catch (error) {
    throw new Error(
      `GitHub App not configured. Invalid local config: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Start GitHub OAuth device flow.
 *
 * @param clientId - GitHub App client_id
 * @returns Device flow response with device_code, user_code, verification_uri, interval
 */
export async function startDeviceFlow(
  clientId: string,
): Promise<DeviceFlowResponse> {
  const response = await fetch("https://github.com/login/device/code", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: clientId,
      scope: "repo",
    }),
  });

  if (!response.ok) {
    throw new Error(
      `GitHub device flow initiation failed: ${response.status} ${response.statusText}`,
    );
  }

  const json = await response.json();

  // Validate verification_uri
  const uri = json.verification_uri;
  if (typeof uri !== "string") {
    throw new Error("Invalid device flow response: missing verification_uri");
  }

  // Security: must be https
  if (!uri.startsWith("https://")) {
    throw new Error(`Invalid verification_uri: must use https (got: ${uri})`);
  }

  // Security: must not have trailing slash
  if (uri.endsWith("/")) {
    throw new Error(
      `Invalid verification_uri: must not have trailing slash (got: ${uri})`,
    );
  }

  // Security: must not have query params
  if (uri.includes("?")) {
    throw new Error(
      `Invalid verification_uri: must not have query params (got: ${uri})`,
    );
  }

  // Security: must be github.com domain
  try {
    const url = new URL(uri);
    if (url.hostname !== "github.com") {
      throw new Error(
        `Invalid verification_uri: must be github.com domain (got: ${url.hostname})`,
      );
    }
  } catch (error) {
    throw new Error(
      `Invalid verification_uri: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return {
    device_code: json.device_code,
    user_code: json.user_code,
    verification_uri: json.verification_uri,
    interval: json.interval,
  };
}

/**
 * Poll GitHub for OAuth token.
 * Handles authorization_pending, slow_down, expired_token, access_denied.
 *
 * @param clientId - GitHub App client_id
 * @param deviceCode - Device code from startDeviceFlow
 * @param interval - Polling interval in seconds
 * @returns Access token
 */
export async function pollForToken(
  clientId: string,
  deviceCode: string,
  interval: number,
): Promise<string> {
  let currentInterval = interval;
  let attempts = 0;
  const maxAttempts = 120;

  while (attempts < maxAttempts) {
    // Wait before polling
    await new Promise((resolve) => setTimeout(resolve, currentInterval * 1000));
    attempts++;

    // Race the fetch against a 30s timeout
    const fetchPromise = fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: clientId,
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error("timeout")), 30000);
    });

    try {
      const response = await Promise.race([fetchPromise, timeoutPromise]);
      clearTimeout(timeoutId);

      // Parse body once — GitHub returns HTTP 200 for all poll responses
      // (including authorization_pending, slow_down, etc.)
      const json = await response.json();
      if (json.access_token) {
        return json.access_token;
      }

      if (json.error) {
        switch (json.error) {
          case "authorization_pending":
            // Continue polling
            break;
          case "slow_down":
            // Increase interval by 5 seconds, cap at 60
            currentInterval = Math.min(currentInterval + 5, 60);
            break;
          case "expired_token":
            throw new Error(
              "expired_token: Device code expired. Please restart the authentication flow.",
            );
          case "access_denied":
            throw new Error(
              "access_denied: Access denied by user. Please restart the authentication flow.",
            );
          default:
            throw new Error(`GitHub OAuth error: ${json.error}`);
        }
      }
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof Error && error.message === "timeout") {
        throw new Error(
          "timeout: GitHub OAuth polling timeout (30s per request)",
        );
      }
      throw error;
    }
  }

  throw new Error(`GitHub OAuth polling timeout after ${maxAttempts} attempts`);
}

/**
 * Resolve GitHub App user token.
 * Resolution order: cached token (if valid) → GITHUB_TOKEN env → interactive device flow.
 *
 * @param config - Configuration with project_id and worker_url
 * @param tilaDir - Path to .tila directory
 * @returns GitHub user token
 */
export async function resolveAppUserToken(
  config: AppUserTokenConfig,
  tilaDir: string,
): Promise<string> {
  // Check cache
  const cachePath = join(tilaDir, "github-token-cache.json");
  if (existsSync(cachePath)) {
    try {
      const cacheContent = readFileSync(cachePath, "utf-8");
      const cache: TokenCacheEntry = JSON.parse(cacheContent);

      // Validate cache entry matches current project
      if (cache.project_id === config.project_id) {
        const now = Date.now() / 1000;
        const ttl = cache.expires_at - now;

        // Use cached token if TTL is at least 10 minutes
        if (ttl >= 600) {
          return cache.user_token;
        }
      }
    } catch (error) {
      // Invalid cache, continue to next resolution method
    }
  }

  // WI-J2 CI fail-closed: ambient GitHub token consumption — the GITHUB_TOKEN
  // env var and the `gh auth token` CLI session — is a CI credential-bleed
  // vector. Under CI, refuse to consume either. CI auth must come from the
  // sanctioned GitHub Actions OIDC flow (resolved by the caller BEFORE this
  // function is reached) or an explicit project token (TILA_TOKEN / --token).
  // The per-project cache above is still honored; it is only ever written by a
  // prior interactive login.
  const isCI = Boolean(process.env.CI);
  if (isCI) {
    throw new Error(
      "Ambient GitHub token consumption (GITHUB_TOKEN / gh CLI) is disabled under CI to prevent credential bleed.\n" +
        "Use the GitHub Actions OIDC flow (set ACTIONS_ID_TOKEN_REQUEST_URL/_TOKEN), or provide an explicit project token (TILA_TOKEN).",
    );
  }

  // Check GITHUB_TOKEN env var
  const envToken = process.env.GITHUB_TOKEN;
  if (envToken && envToken.trim() !== "") {
    // Warn if classic PAT (ghp_) is used
    // Fine-grained PATs start with github_pat_
    // App installation tokens start with ghs_
    // App user tokens start with ghu_
    if (envToken.startsWith("ghp_")) {
      p.log.warn(
        "GITHUB_TOKEN appears to be a classic PAT. Consider using a fine-grained PAT or GitHub App token instead.",
      );
    }
    return envToken;
  }

  // Try gh CLI session (after env var, before interactive device flow)
  try {
    const { execSync } = await import("node:child_process");
    const ghToken = execSync("gh auth token", {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    if (ghToken) return ghToken;
  } catch {
    // gh CLI not installed or not authenticated — continue to device flow
  }

  // Fall back to interactive device flow — requires an interactive terminal
  if (!process.stdin.isTTY) {
    throw new Error(
      "No GitHub token available. Set GITHUB_TOKEN environment variable or run 'tila init' in an interactive terminal.",
    );
  }

  // Fetch GitHub App client_id
  const clientId = await fetchClientId(config.worker_url, tilaDir);

  // Start device flow
  const deviceFlow = await startDeviceFlow(clientId);

  // Display user code and verification URI
  p.note(
    `Open this URL in your browser to authorize tila:\n\n  ${deviceFlow.verification_uri}\n\nThen enter code: ${deviceFlow.user_code}`,
    "GitHub Device Flow",
  );

  // Best-effort browser open — errors are swallowed internally by openInBrowser
  openInBrowser(deviceFlow.verification_uri);

  // Poll for token
  const token = await pollForToken(
    clientId,
    deviceFlow.device_code,
    deviceFlow.interval,
  );

  // Write token to cache (cachePath was declared above for the read path)
  writeFileSync(
    cachePath,
    JSON.stringify({
      user_token: token,
      expires_at: Date.now() / 1000 + 28800,
      project_id: config.project_id,
    }),
    { mode: 0o600 },
  );

  return token;
}
