import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findConfig, findTilaDir } from "./config";
import { resolveGithubRepoToken } from "./lib/github-exchange";

const TOKEN_ENV_VAR = "TILA_API_TOKEN";
const ENV_FILENAME = ".env";

/**
 * Resolve the API token. Priority depends on auth mode:
 *
 * Mode "tila-token" (default):
 *   1. TILA_API_TOKEN environment variable
 *   2. .tila/.env file
 *
 * Mode "github-repo":
 *   Returns null (async resolution is needed — use requireTokenAsync)
 *
 * Returns the token string or null if not found.
 */
export function resolveToken(): string | null {
  const config = findConfig();
  const authMode = config?.auth?.mode ?? "tila-token";

  if (authMode === "github-repo") {
    // Async mode: return null to signal that async resolution is needed
    return null;
  }

  // Default: tila-token mode
  // 1. Environment variable takes priority
  const envToken = process.env[TOKEN_ENV_VAR];
  if (envToken && envToken.trim().length > 0) {
    return envToken.trim();
  }

  // 2. Fall back to .tila/.env file
  const tilaDir = findTilaDir();
  if (!tilaDir) {
    return null;
  }

  const envFilePath = join(tilaDir, ENV_FILENAME);
  if (!existsSync(envFilePath)) {
    return null;
  }

  const content = readFileSync(envFilePath, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#") || trimmed.length === 0) {
      continue;
    }
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();
    // Strip optional surrounding quotes
    const unquoted = value.replace(/^["']|["']$/g, "");
    if (key === TOKEN_ENV_VAR) {
      return unquoted;
    }
  }

  return null;
}

/**
 * Write the raw API token to <dir>/.env with restrictive permissions.
 * Creates the directory if it doesn't exist.
 */
export function writeTokenFile(rawToken: string, dir = ".tila"): void {
  mkdirSync(dir, { recursive: true });
  const content = `TILA_API_TOKEN=${rawToken}\n`;
  writeFileSync(join(dir, ENV_FILENAME), content, {
    mode: 0o600,
    encoding: "utf-8",
  });
}

/**
 * Resolve the API token or throw with actionable error (sync, legacy).
 *
 * For tila-token mode: resolves synchronously from env/file.
 * For github-repo mode: tries cached session first; if no valid cache, throws
 *   directing user to use requireTokenAsync or ensure session cache is fresh.
 */
export function requireToken(): string {
  const config = findConfig();
  const authMode = config?.auth?.mode ?? "tila-token";

  if (authMode === "github-repo") {
    // For github-repo mode, try a sync cache read first
    const tilaDir = findTilaDir();
    if (tilaDir) {
      const sessionPath = join(tilaDir, ".session");
      if (existsSync(sessionPath)) {
        try {
          const content = readFileSync(sessionPath, "utf-8");
          const cached = JSON.parse(content) as {
            session_token: string;
            expires_at: number;
          };
          if (cached.expires_at - Date.now() / 1000 > 600) {
            return cached.session_token;
          }
        } catch {
          // Fall through
        }
      }
    }
    throw new Error(
      'Auth mode is "github-repo" — use requireTokenAsync() for async token resolution.',
    );
  }

  const token = resolveToken();
  if (!token) {
    throw new Error(
      `No API token found.\n\nSet the ${TOKEN_ENV_VAR} environment variable, or add it to .tila/.env:\n  ${TOKEN_ENV_VAR}=your-token-here\n\nRun 'tila project create' to provision a new project, or 'tila init' to join an existing one.`,
    );
  }
  return token;
}

/**
 * Resolve the API token or throw with actionable error (async).
 * Supports both sync (tila-token) and async (github-repo) modes.
 */
export async function requireTokenAsync(): Promise<string> {
  const config = findConfig();
  const tilaDir = findTilaDir();

  const authMode = config?.auth?.mode ?? "tila-token";

  if (authMode === "github-repo") {
    if (!config || !tilaDir) {
      throw new Error("No .tila/config.toml found. Run `tila init` first.");
    }
    // Validate github section
    const github = (
      config as {
        github?:
          | { host?: string; owner?: string; repo?: string; repo_id?: number }
          | undefined;
      }
    ).github;
    if (!github) {
      throw new Error(
        'Auth mode is "github-repo" but [github] section is missing from .tila/config.toml.\n\nAdd:\n  [github]\n  owner = "your-org"\n  repo = "your-repo"\n',
      );
    }
    if (!config.worker_url) {
      throw new Error(
        'Auth mode is "github-repo" requires a Cloudflare backend with worker_url set in .tila/config.toml.',
      );
    }
    return resolveGithubRepoToken(
      { ...config, worker_url: config.worker_url },
      tilaDir,
    );
  }

  // tila-token mode (sync)
  const token = resolveToken();
  if (!token) {
    throw new Error(
      `No API token found.\n\nSet the ${TOKEN_ENV_VAR} environment variable, or add it to .tila/.env:\n  ${TOKEN_ENV_VAR}=your-token-here\n\nRun 'tila project create' to provision a new project, or 'tila init' to join an existing one.`,
    );
  }
  return token;
}
