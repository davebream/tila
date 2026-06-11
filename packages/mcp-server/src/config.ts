import { existsSync, readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { TilaProjectConfigSchema } from "@tila/schemas";
import { parse } from "smol-toml";
import { createGithubTokenProvider } from "./github-auth";

/**
 * Resolved MCP server config. Discriminated union keyed on `mode`:
 *   - "remote": talks to a tila Worker over HTTP (apiUrl + token auth).
 *   - "local":  reads/writes a local SQLite DB + artifacts dir, no token.
 */
export type McpServerConfig =
  | {
      mode: "remote";
      apiUrl: string;
      projectId: string;
      authMode: "tila-token" | "github-repo";
      getToken: () => Promise<string>;
    }
  | {
      mode: "local";
      projectId: string;
      dbPath: string;
      artifactsPath: string;
      org: string;
    };

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

/** Read an env var, treating empty/whitespace-only as unset. */
function envOr(name: string): string | undefined {
  const v = process.env[name]?.trim();
  return v && v.length > 0 ? v : undefined;
}

/**
 * Resolve MCP server config from environment and .tila/config.toml.
 * Throws with actionable error messages on missing required values.
 *
 * Returns a discriminated union keyed on `mode`:
 *   - "local":  when config.toml has backend = "local" (no worker_url/token needed)
 *   - "remote": otherwise (existing tila-token / github-repo behavior)
 *
 * Backend mode priority (issue #24):
 *   backendMode: TILA_BACKEND env ("local" | "cloudflare") -> config.toml `backend` -> default "cloudflare"
 *                An invalid TILA_BACKEND value throws an actionable error.
 *
 * Remote priority:
 *   apiUrl:    TILA_API_URL env -> config.toml worker_url
 *   projectId: TILA_PROJECT_ID env -> config.toml project_id
 *   getToken:  tila-token mode: static TILA_API_TOKEN / .tila/.env
 *              github-repo mode: session cache -> OIDC -> error
 *
 * Local priority (config value -> TILA_* env -> default):
 *   dbPath:        config.local.db_path     -> TILA_DB_PATH
 *   artifactsPath: config.local.artifacts_path -> TILA_ARTIFACTS_PATH
 *   org:           config.local.org         -> TILA_ORG -> OS username
 *   projectId:     config.project_id        -> TILA_PROJECT_ID
 */
export async function resolveServerConfig(): Promise<McpServerConfig> {
  const rawConfig = findConfigRaw();
  const tilaDir = findTilaDir();
  const config = rawConfig
    ? TilaProjectConfigSchema.safeParse(rawConfig)
    : null;

  // Resolve projectId early (shared by both local and remote arms; treat empty as unset)
  const projectId =
    envOr("TILA_PROJECT_ID") ??
    (config?.success ? config.data.project_id : undefined);

  // Backend mode: TILA_BACKEND env overrides config.toml `backend`, else defaults
  // to "cloudflare". The env override lets an env-only embedder select local mode
  // with no .tila/config.toml present (issue #24). Local backend never requires a
  // worker_url or a token.
  const backendEnv = envOr("TILA_BACKEND");
  if (
    backendEnv !== undefined &&
    backendEnv !== "local" &&
    backendEnv !== "cloudflare"
  ) {
    throw new Error(
      `Invalid TILA_BACKEND value "${backendEnv}". Expected "local" or "cloudflare".`,
    );
  }
  const backendMode =
    backendEnv ??
    (config?.success ? (config.data.backend ?? "cloudflare") : "cloudflare");

  if (backendMode === "local") {
    if (!projectId) {
      throw new Error(
        "No project ID found. Set TILA_PROJECT_ID environment variable or add project_id to .tila/config.toml.",
      );
    }

    const local = config?.success ? config.data.local : undefined;
    const dbPath = local?.db_path ?? envOr("TILA_DB_PATH");
    if (!dbPath) {
      throw new Error(
        "Backend is local but no database path found. Set TILA_DB_PATH environment variable or add db_path to the [local] section of .tila/config.toml.",
      );
    }
    const artifactsPath = local?.artifacts_path ?? envOr("TILA_ARTIFACTS_PATH");
    if (!artifactsPath) {
      throw new Error(
        "Backend is local but no artifacts path found. Set TILA_ARTIFACTS_PATH environment variable or add artifacts_path to the [local] section of .tila/config.toml.",
      );
    }
    const org = local?.org ?? envOr("TILA_ORG") ?? defaultOrg();

    return {
      mode: "local",
      projectId,
      // Resolve to absolute paths so a relative `db_path`/`artifacts_path` (from
      // config or TILA_DB_PATH/TILA_ARTIFACTS_PATH) is deterministic regardless
      // of the process cwd at open time.
      dbPath: resolve(dbPath),
      artifactsPath: resolve(artifactsPath),
      org,
    };
  }

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

  // projectId resolved above (shared with local arm); require it for remote too.
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
      mode: "remote",
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
    mode: "remote",
    apiUrl,
    projectId,
    authMode: "tila-token",
    getToken: () => Promise.resolve(apiToken),
  };
}

/**
 * Default org when neither config.local.org nor TILA_ORG is set.
 * Mirrors the CLI's local fallback chain; the OS username is the final default.
 */
function defaultOrg(): string {
  try {
    return userInfo().username;
  } catch {
    return "local";
  }
}
