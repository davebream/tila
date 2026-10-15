import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { KeychainUnavailableError } from "./auth-store/errors";
import { findConfig, findTilaDir } from "./config";
import { resolveGithubRepoToken } from "./lib/github-exchange";

import { getGlobalFlags } from "./lib/global-flags";

const TOKEN_ENV_VAR = "TILA_API_TOKEN";
const ENV_FILENAME = ".env";
// Typed against the error class so a renamed code fails typecheck. Matching the
// code rather than `instanceof` also recognizes the error across duplicate or
// bundled copies of the auth-store module.
const KEYCHAIN_UNAVAILABLE: KeychainUnavailableError["code"] =
  "KEYCHAIN_UNAVAILABLE";

function isKeychainUnavailable(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === KEYCHAIN_UNAVAILABLE
  );
}

function resolveEnvToken(): string | null {
  for (const name of ["TILA_TOKEN", TOKEN_ENV_VAR]) {
    const token = process.env[name]?.trim();
    if (token) return token;
  }
  return null;
}

/**
 * Resolve the API token. Priority depends on auth mode:
 *
 * Mode "tila-token" (default):
 *   1. Explicit --token (also overrides github-repo mode)
 *   2. TILA_TOKEN environment variable
 *   3. TILA_API_TOKEN legacy environment alias
 *   4. .tila/.env file (TILA_API_TOKEN key)
 *
 * Mode "github-repo":
 *   Returns null (async resolution is needed — use requireTokenAsync)
 *
 * Returns the token string or null if not found.
 */
export function resolveToken(): string | null {
  const inline = getGlobalFlags().token;
  if (inline !== undefined) return inline;
  const config = findConfig();
  const authMode = config?.auth?.mode ?? "tila-token";

  if (authMode === "github-repo") {
    // Async mode: return null to signal that async resolution is needed
    return null;
  }

  // Default: tila-token mode
  const envToken = resolveEnvToken();
  if (envToken) return envToken;

  // Fall back to the legacy .tila/.env file key.
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
  const inline = getGlobalFlags().token;
  if (inline !== undefined) return inline;
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
      `No API token found.\n\nSet TILA_TOKEN (or the legacy ${TOKEN_ENV_VAR} environment alias), or add a token to .tila/.env:\n  ${TOKEN_ENV_VAR}=your-token-here\n\nRun 'tila project create' to provision a new project, or 'tila init' to join an existing one.`,
    );
  }
  return token;
}

/**
 * Resolve the API token or throw with actionable error (async).
 * After the managed-runtime guard, --token and then the trimmed TILA_TOKEN /
 * TILA_API_TOKEN env fallback precede human sessions and either auth mode.
 * A human session lookup that finds the keychain unavailable (recognized by
 * its stable error code) counts as no session and emits one token-free stderr
 * warning; other lookup failures propagate.
 */
export async function requireTokenAsync(): Promise<string> {
  if (
    process.env.TILA_RUN_SOCKET ||
    process.env.TILA_RUN_CAPABILITY ||
    process.env.TILA_LIFECYCLE_KEY ||
    process.env.CODEX_THREAD_ID
  )
    throw Object.assign(
      new Error(
        "Managed commands must use the runtime broker; operator credential fallback is forbidden",
      ),
      { code: "runtime-purpose-denied" },
    );
  const inline = getGlobalFlags().token;
  if (inline !== undefined) return inline;
  const config = findConfig();
  const tilaDir = findTilaDir();

  const envToken = resolveEnvToken();
  if (envToken) return envToken;
  if (config?.worker_url && !process.env.CI && process.stdin.isTTY) {
    const { humanSessionStore } = await import("./lib/human-login");
    try {
      const session = await humanSessionStore().get(config.worker_url);
      if (session) return session.token;
    } catch (error) {
      // A keychain that cannot be reached holds no readable login, so project
      // token resolution continues exactly as it does without a TTY. Any other
      // failure (corrupt stored login, identity mismatch) still propagates.
      if (!isKeychainUnavailable(error)) throw error;
      // A locked keychain may hold a login, so say that the identity changed.
      // Static text only: no token, URL or error cause reaches the output.
      const { warning } = await import("./lib/output");
      warning(
        "OS keychain unavailable; any remembered login was not used. Falling back to project credentials.",
      );
    }
  }
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
      `No API token found.\n\nSet TILA_TOKEN (or the legacy ${TOKEN_ENV_VAR} environment alias), or add a token to .tila/.env:\n  ${TOKEN_ENV_VAR}=your-token-here\n\nRun 'tila project create' to provision a new project, or 'tila init' to join an existing one.`,
    );
  }
  return token;
}
