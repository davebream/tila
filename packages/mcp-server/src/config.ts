import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  AuthStore,
  KeyringSecretStore,
  TilaPaths,
  createProvider,
  resolveWithTrace,
} from "@tila/auth-store";
import type {
  Clock,
  CredentialKind,
  CredentialProvider,
  EnvProbe,
  MintedCredential,
  Prompter,
  ProviderContext,
  ProviderPorts,
  RepoPointer,
  ResolveInput,
  ResolvedInstance,
  ResolverEnv,
  RunCommand,
  SecretStore,
} from "@tila/auth-store";
import type {
  CredentialProviderConfig,
  CredentialRecord,
  InstanceKey,
  RefreshRecord,
} from "@tila/schemas";
import { TilaProjectConfigSchema } from "@tila/schemas";
import { parse } from "smol-toml";

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
 * Extract the credential token from a ResolvedInstance.
 *
 * Handles both inline-token (from --token / TILA_TOKEN) and
 * keychain (from the OS keychain via AuthStore) credential sources.
 */
function extractToken(instance: ResolvedInstance): string {
  if (
    instance.credential.source === "inline-token" ||
    instance.credential.source === "legacy"
  ) {
    return instance.credential.token;
  }
  // keychain source: CredentialRecord
  return instance.credential.record.token;
}

/** A NOOP runCommand for the MCP server's headless ProviderPorts. */
const headlessRunCommand: RunCommand = async (command, args) => {
  const result = await new Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
  }>((resolve) => {
    execFile(command, args, { timeout: 30_000 }, (err, stdout, stderr) => {
      const exitCode =
        err != null ? (typeof err.code === "number" ? err.code : 1) : 0;
      resolve({ exitCode, stdout, stderr });
    });
  });
  return result;
};

/**
 * Attempt a non-interactive (HTTP-only) credential refresh for the given
 * instance key. Returns the refreshed token on success, or null on any failure.
 *
 * CRITICAL (C3): worker_url is sourced from the registry-pinned instanceRecord,
 * NOT from config.toml. The resolver trust gate fires in resolveWithTrace before
 * this function; if the refresh URL were taken from user-controlled config, a
 * malicious project config could redirect the refresh exchange after the trust
 * gate already rejected the spoofed URL.
 *
 * R5: when minted.refresh_token is present (rotation), persist it too, but swallow
 * a putRefresh-only failure so a successful credential write is never discarded.
 */
async function attemptRefresh(
  authStore: AuthStore,
  instanceKey: InstanceKey,
  envProbe: EnvProbe,
  providerFactory: (kind: CredentialKind) => CredentialProvider,
  fetchImpl: typeof fetch,
): Promise<string | null> {
  // Defense-in-depth: skip refresh entirely in CI. resolveWithTrace already fails
  // closed in CI, but an exec-provider kind would still run its external command
  // before the write gate fires if we reached this point. Return null immediately.
  if (envProbe.isCI) return null;

  const refreshRecord = await authStore.getRefresh(instanceKey);
  if (!refreshRecord) return null;

  // CRITICAL (C3): use the registry-pinned worker_url, never config.toml
  const instanceRecord = await authStore.getInstance(instanceKey);
  if (!instanceRecord) return null;

  const kind: CredentialKind =
    instanceRecord.credential_provider?.kind ?? "github";
  const provider = providerFactory(kind);

  const noopPrompter: Prompter = {
    displayDeviceCode: async () => {
      throw new Error(
        "MCP server is headless — run 'tila auth login' from a terminal to refresh credentials",
      );
    },
  };

  const realClock: Clock = {
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };

  const ports: ProviderPorts = {
    fetch: fetchImpl,
    prompter: noopPrompter,
    env: envProbe,
    clock: realClock,
    runCommand: headlessRunCommand,
  };

  // CRITICAL (C3): worker_url from registry record (immutable), NOT repoPointer
  const ctx: ProviderContext = {
    instance_key: instanceKey,
    worker_url: instanceRecord.worker_url,
    ports,
    config:
      instanceRecord.credential_provider ??
      ({ kind } as CredentialProviderConfig),
  };

  // Only provider.refresh() failure returns null — storage failures must not
  // discard a legitimately authenticated token.
  let minted: MintedCredential;
  try {
    minted = await provider.refresh(ctx, refreshRecord);
  } catch {
    return null; // refresh() failed — caller emits actionable error
  }

  const credRecord: CredentialRecord = {
    instance_key: instanceKey,
    obtained_at: Date.now(),
    token: minted.token,
    token_type: minted.token_type,
    expires_at: minted.expires_at,
    scope: minted.scope,
  };

  // Wrap putCredential separately: a transient keychain write failure must not
  // discard a legitimately refreshed token — only caching is denied. The token
  // was authenticated against the registry-pinned URL; next startup re-refreshes.
  // IMPORTANT: never include the token value in the warning message.
  try {
    await authStore.putCredential(instanceKey, credRecord);
  } catch (err) {
    process.stderr.write(
      `tila-mcp-server: warning: failed to persist refreshed credential: ${(err as Error).message}\n`,
    );
  }

  // R5: persist rotated refresh token, swallow putRefresh-only failure
  if (minted.refresh_token) {
    try {
      const newRefreshRecord: RefreshRecord = {
        instance_key: instanceKey,
        refresh_token: minted.refresh_token,
        expires_at: minted.refresh_expires_at ?? null,
        obtained_at: Date.now(),
      };
      await authStore.putRefresh(instanceKey, newRefreshRecord);
    } catch (err) {
      process.stderr.write(
        `tila-mcp-server: warning: failed to persist rotated refresh token: ${(err as Error).message}\n`,
      );
    }
  }

  return minted.token;
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
 *   getToken:  Priority 1 (tila-token): static TILA_API_TOKEN / .tila/.env wins unconditionally
 *              Priority 2 (resolver path): AuthStore + resolveWithTrace (keychain-backed,
 *                HTTP-only refresh for refreshable provider kinds)
 *
 * DESKTOP DAEMON NOTE: the MCP server is an stdio subprocess with process.stdin.isTTY === false.
 * Both the AuthStore EnvProbe and the resolver ResolverEnv are constructed with isTTY: true so
 * the keychain read path and credential write path are both enabled. isCI is kept from the real
 * process.env.CI so genuine CI still fails closed to the TILA_API_TOKEN path.
 *
 * @param deps — injectable seam for testing (defaults to production implementations)
 */
export async function resolveServerConfig(deps?: {
  secretStore?: SecretStore;
  envProbe?: EnvProbe;
  resolverEnv?: ResolverEnv;
  providerFactory?: (kind: CredentialKind) => CredentialProvider;
  fetchImpl?: typeof fetch;
}): Promise<McpServerConfig> {
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

  // -------------------------------------------------------------------------
  // Priority 1: TILA_API_TOKEN in env or .tila/.env wins unconditionally.
  // The static token is the explicit credential; return immediately without
  // constructing an AuthStore or reading TILA_INSTANCE.
  // -------------------------------------------------------------------------
  const apiToken = resolveToken(tilaDir);
  if (apiToken) {
    return {
      mode: "remote",
      apiUrl,
      projectId,
      authMode: "tila-token",
      getToken: () => Promise.resolve(apiToken),
    };
  }

  if (authMode === "github-repo") {
    // -------------------------------------------------------------------------
    // Priority 2: Resolver path (keychain-backed + HTTP-only refresh).
    //
    // DESKTOP DAEMON: the MCP server is a stdio subprocess (process.stdin.isTTY
    // === false). Both the AuthStore EnvProbe and resolver ResolverEnv MUST use
    // isTTY: true so the keychain read gate (evaluateCiPolicy) and credential
    // write gate (AuthStore.#assertWriteAllowed) are both enabled. isCI is kept
    // from the real process.env.CI so genuine CI still fails closed.
    // -------------------------------------------------------------------------
    const isCI = Boolean(process.env.CI);

    const secretStore = deps?.secretStore ?? new KeyringSecretStore();
    // Daemon env: isTTY overridden to true (MCP server is a desktop daemon, not CI)
    const daemonEnvProbe: EnvProbe = deps?.envProbe ?? {
      isCI,
      isTTY: true,
    };
    const daemonResolverEnv: ResolverEnv = deps?.resolverEnv ?? {
      isCI,
      isTTY: true,
      tilaHomeOverridden: Boolean(process.env.TILA_HOME),
    };
    const providerFactory = deps?.providerFactory ?? createProvider;
    const fetchImpl = deps?.fetchImpl ?? globalThis.fetch;

    const tilaPaths = new TilaPaths();
    const authStore = new AuthStore({
      paths: tilaPaths,
      secrets: secretStore,
      env: daemonEnvProbe,
    });

    // Build the repo pointer from config.toml if present.
    // NOTE: instance_key is nested at config.data.instance?.instance_key (string | undefined)
    // and must be cast to InstanceKey | null. The resolver will fall through to
    // the current-context rung when instance_key is null (no [instance] section).
    const repoPointer: RepoPointer =
      config?.success && config.data.instance?.instance_key
        ? {
            instance_key: config.data.instance.instance_key as InstanceKey,
            worker_url: apiUrl,
          }
        : {
            instance_key: null,
            worker_url: apiUrl,
          };

    const getToken = async (): Promise<string> => {
      const input: ResolveInput = {
        envReader: (n) => process.env[n],
        env: daemonResolverEnv,
        authStore,
        repoPointer,
      };

      const outcome = await resolveWithTrace(input);
      if (outcome.ok) {
        return extractToken(outcome.instance);
      }

      // Resolver failed (e.g. expired credential). Resolve the instance key for
      // the refresh path. Priority: TILA_INSTANCE env → config.toml → current_context.
      const rawTilaInstance = process.env.TILA_INSTANCE?.trim();
      const instanceKey: InstanceKey | null =
        (rawTilaInstance && rawTilaInstance.length > 0
          ? (rawTilaInstance as InstanceKey)
          : null) ??
        (config?.success && config.data.instance?.instance_key
          ? (config.data.instance.instance_key as InstanceKey)
          : null) ??
        (await authStore.getCurrentContext());

      if (instanceKey) {
        const refreshed = await attemptRefresh(
          authStore,
          instanceKey,
          daemonEnvProbe,
          providerFactory,
          fetchImpl,
        );
        if (refreshed !== null) return refreshed;
      }

      // Refresh impossible — write actionable message to stderr (R2) AND throw.
      // getToken() runs at startup before the transport connects; a bare throw shows
      // only "server disconnected" in the client's MCP log pane. Writing to stderr
      // ensures the "tila auth login" instruction is visible.
      const msg = `Tila auth failed: ${outcome.error.message}\nRun 'tila auth login' from a terminal to re-authenticate.`;
      process.stderr.write(`${msg}\n`);
      throw new Error(msg);
    };

    return {
      mode: "remote",
      apiUrl,
      projectId,
      authMode: "github-repo",
      getToken,
    };
  }

  // tila-token mode with no static token — throw the existing actionable error.
  throw new Error(
    "No API token found. Set TILA_API_TOKEN environment variable or add it to .tila/.env:\n  TILA_API_TOKEN=your-token",
  );
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
