import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { TilaProjectConfigSchema } from "@tila/schemas";
import { parse } from "smol-toml";
import { createGithubTokenProvider } from "./github-auth";

export interface McpServerConfig {
  apiUrl: string;
  projectId: string;
  authMode: "tila-token" | "github-repo";
  getToken: () => Promise<string>;
}

const CONFIG_DIR = ".tila";
const CONFIG_FILENAME = "config.toml";
const TOKEN_ENV_VAR = "TILA_API_TOKEN";

/**
 * Walk up from startDir looking for .tila/config.toml.
 * Returns the raw parsed TOML object or null if not found.
 */
function findConfigRaw(startDir?: string): Record<string, unknown> | null {
  let dir = resolve(startDir ?? process.cwd());
  const root = resolve("/");

  while (true) {
    const candidate = join(dir, CONFIG_DIR, CONFIG_FILENAME);
    if (existsSync(candidate)) {
      const raw = readFileSync(candidate, "utf-8");
      return parse(raw) as Record<string, unknown>;
    }
    if (dir === root) return null;
    dir = dirname(dir);
  }
}

/**
 * Walk up from startDir looking for .tila/ directory.
 * Returns the directory path or null if not found.
 */
function findTilaDir(startDir?: string): string | null {
  let dir = resolve(startDir ?? process.cwd());
  const root = resolve("/");

  while (true) {
    const candidate = join(dir, CONFIG_DIR);
    if (existsSync(join(candidate, CONFIG_FILENAME))) {
      return candidate;
    }
    if (dir === root) return null;
    dir = dirname(dir);
  }
}

/**
 * Read TILA_API_TOKEN from env or .tila/.env file.
 * Returns null if not found. Does not throw.
 */
function resolveToken(tilaDir: string | null): string | null {
  const envToken = process.env[TOKEN_ENV_VAR];
  if (envToken && envToken.trim().length > 0) {
    return envToken.trim();
  }

  if (!tilaDir) return null;

  const envFilePath = join(tilaDir, ".env");
  if (!existsSync(envFilePath)) return null;

  const content = readFileSync(envFilePath, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#") || trimmed.length === 0) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();
    const unquoted = value.replace(/^["']|["']$/g, "");
    if (key === TOKEN_ENV_VAR) return unquoted;
  }

  return null;
}

/**
 * Resolve MCP server config from environment and .tila/config.toml.
 * Throws with actionable error messages on missing required values.
 *
 * Priority:
 *   apiUrl:    TILA_API_URL env -> config.toml worker_url
 *   projectId: TILA_PROJECT_ID env -> config.toml project_id
 *   getToken:  tila-token mode: static TILA_API_TOKEN / .tila/.env
 *              github-repo mode: session cache -> OIDC -> error
 */
export async function resolveServerConfig(): Promise<McpServerConfig> {
  const rawConfig = findConfigRaw();
  const tilaDir = findTilaDir();
  const config = rawConfig
    ? TilaProjectConfigSchema.safeParse(rawConfig)
    : null;

  // Determine auth mode from config (default: tila-token)
  const authMode: "tila-token" | "github-repo" = config?.success
    ? (config.data.auth?.mode ?? "tila-token")
    : "tila-token";

  // Resolve apiUrl (treat empty string as unset)
  const apiUrlEnv = process.env.TILA_API_URL?.trim().length
    ? process.env.TILA_API_URL.trim()
    : undefined;
  const apiUrl =
    apiUrlEnv ?? (config?.success ? config.data.worker_url : undefined);
  if (!apiUrl) {
    throw new Error(
      "No tila project URL found. Set TILA_API_URL environment variable or run `tila project create` to create a .tila/config.toml with worker_url.",
    );
  }

  // Resolve projectId (treat empty string as unset)
  const projectIdEnv = process.env.TILA_PROJECT_ID?.trim().length
    ? process.env.TILA_PROJECT_ID.trim()
    : undefined;
  const projectId =
    projectIdEnv ?? (config?.success ? config.data.project_id : undefined);
  if (!projectId) {
    throw new Error(
      "No project ID found. Set TILA_PROJECT_ID environment variable or add project_id to .tila/config.toml.",
    );
  }

  if (authMode === "github-repo") {
    // Validate that the config has the required [github] section
    if (!config?.success || !config.data.github) {
      throw new Error(
        "Auth mode is github-repo but [github] section is missing from .tila/config.toml.\nAdd a [github] section with owner and repo fields.",
      );
    }

    // Validate that worker_url is set (required for OIDC audience and exchange endpoint)
    const workerUrl = config.data.worker_url;
    if (!workerUrl) {
      throw new Error(
        "Auth mode is github-repo but worker_url is missing from .tila/config.toml.\nAdd worker_url to .tila/config.toml.",
      );
    }

    const githubTilaDir = tilaDir ?? join(process.cwd(), CONFIG_DIR);

    return {
      apiUrl,
      projectId,
      authMode: "github-repo",
      getToken: createGithubTokenProvider(
        { project_id: projectId, worker_url: workerUrl },
        githubTilaDir,
      ),
    };
  }

  // tila-token mode (default, backward-compatible)
  const apiToken = resolveToken(tilaDir);
  if (!apiToken) {
    throw new Error(
      "No API token found. Set TILA_API_TOKEN environment variable or add it to .tila/.env:\n  TILA_API_TOKEN=your-token",
    );
  }

  return {
    apiUrl,
    projectId,
    authMode: "tila-token",
    getToken: () => Promise.resolve(apiToken),
  };
}
