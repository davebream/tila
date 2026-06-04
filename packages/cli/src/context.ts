import { hostname } from "node:os";
import { LocalArtifactBackend, LocalProject } from "@tila/backend-local";
import type {
  ArtifactBackend,
  CoordinationBackend,
  EntityBackend,
  GateBackend,
  JournalBackend,
  SchemaBackend,
  SignalBackend,
  SummaryBackend,
} from "@tila/core";
import type { TilaProjectConfig } from "@tila/schemas";
import type { TilaClient } from "tila-sdk";
import { requireTokenAsync } from "./auth";
import { RemoteArtifactBackend, RemoteBackend } from "./backends/remote";
import { findConfig } from "./config";
import { createCliClientFromConfig } from "./lib/client-factory";
import { warnIfRemoteMismatch } from "./lib/github-exchange";
import { deriveOrg, resolveCfApiToken } from "./lib/provisioning";
import { checkAccountMatch, verifyCloudflareAuth } from "./lib/wrangler";

export interface CommandContext {
  config: TilaProjectConfig;
  /** Retained for carved-out commands with no backend interface equivalent. Null in local mode. */
  client: TilaClient | null;
  /** Machine identity resolved from TILA_MACHINE env var or os.hostname(). */
  machine: string;
  entity: EntityBackend;
  coordination: CoordinationBackend;
  artifact: ArtifactBackend;
  journal: JournalBackend;
  gate: GateBackend;
  signal: SignalBackend;
  schema: SchemaBackend;
  summary: SummaryBackend;
}

export function requireClient(ctx: CommandContext): TilaClient {
  if (!ctx.client) {
    throw new Error("This command requires a remote backend (not local mode).");
  }
  return ctx.client;
}

export interface StartupCheckOptions {
  /** Skip Cloudflare auth and account-match checks (steps 3-5). */
  skipAuth?: boolean;
}

/**
 * Run the 5-step startup auth check sequence:
 *   1. Find .tila/config.toml (project context)
 *   1.5. Check backend mode (local mode: constructs LocalProject + LocalArtifactBackend and returns early)
 *   2. Verify API token present (env var or .tila/.env)
 *   3. Verify Cloudflare API token     (skipped if skipAuth or non-cloudflare)
 *   4. Check account ID match           (skipped if skipAuth or non-cloudflare)
 *
 * Cheap checks (config, token) run first. Expensive checks (Cloudflare
 * API calls) run only when needed and only when not skipped.
 *
 * Returns a CommandContext with config + HTTP client + backend interfaces on success.
 * Throws with actionable error messages on any failure.
 */
export async function runStartupChecks(
  opts?: StartupCheckOptions,
): Promise<CommandContext> {
  const skipAuth = opts?.skipAuth ?? false;

  // Step 0: Machine identity
  const machine = process.env.TILA_MACHINE || hostname();

  // Step 1: Project context
  const config = findConfig();
  if (!config) {
    throw new Error(
      "No tila project found.\n\n" +
        "Run 'tila project create' to create a new project, " +
        "or 'tila init' to join an existing one.\n\n" +
        "Looking for: .tila/config.toml (searched from cwd upward)",
    );
  }

  // Step 1.5: Backend mode
  const backendMode = config.backend ?? "cloudflare";

  if (backendMode === "local") {
    if (!config.local?.db_path || !config.local?.artifacts_path) {
      throw new Error(
        "Config has backend = 'local' but missing [local] section.\n" +
          "Run 'tila init --local' to provision the local backend.",
      );
    }
    const org = config.local.org ?? deriveOrg(process.cwd());
    const localProject = LocalProject.open(
      config.local.db_path,
      org,
      config.project_id,
    );
    const localArtifact = new LocalArtifactBackend(
      localProject.getDb(),
      config.local.artifacts_path,
      org,
      config.project_id,
    );
    return {
      config,
      client: null,
      machine,
      entity: localProject,
      coordination: localProject,
      artifact: localArtifact,
      journal: localProject,
      gate: localProject,
      signal: localProject,
      schema: localProject,
      summary: localProject,
    };
  }

  // Step 2: API token (async for github-repo mode)
  const token = await requireTokenAsync();

  // Step 2.5: Git remote mismatch warning (github-repo mode only)
  const authMode = config?.auth?.mode ?? "tila-token";
  if (authMode === "github-repo") {
    warnIfRemoteMismatch(config, process.cwd());
  }

  // Steps 3-5: Cloudflare auth checks (skipped with --skip-auth or non-cloudflare backend)
  if (!skipAuth && backendMode === "cloudflare") {
    const cfToken = resolveCfApiToken();
    if (cfToken) {
      const whoami = await verifyCloudflareAuth(cfToken);
      if (config.cloudflare?.account_id) {
        checkAccountMatch(config.cloudflare.account_id, whoami);
      }
    } else {
      console.log(
        "  Skipping Cloudflare account verification (CLOUDFLARE_API_TOKEN not set).",
      );
    }
  }

  const client = createCliClientFromConfig(config, token);
  // RemoteBackend implements EntityBackend + CoordinationBackend.
  // RemoteArtifactBackend implements ArtifactBackend separately — required
  // because EntityBackend and ArtifactBackend share get/list method names
  // with incompatible return types; a single class cannot satisfy both.
  const remote = new RemoteBackend(client, config.project_id);
  const remoteArtifact = new RemoteArtifactBackend(client, config.project_id);
  return {
    config,
    client,
    machine,
    entity: remote,
    coordination: remote,
    artifact: remoteArtifact,
    journal: remote,
    gate: remote,
    signal: remote,
    schema: remote,
    summary: remote,
  };
}

/**
 * Resolve project config, auth token, and build the HTTP client.
 * Equivalent to runStartupChecks({ skipAuth: true }) -- no Cloudflare auth checks.
 * Kept for backward compatibility with existing commands.
 */
export async function resolveContext(): Promise<CommandContext> {
  return runStartupChecks({ skipAuth: true });
}
