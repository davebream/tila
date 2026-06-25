import { join } from "node:path";
import * as p from "@clack/prompts";
import {
  type TrustDecision,
  createProvider,
  processEnvProbe,
} from "@tila/auth-store";
import type { CredentialProviderConfig } from "@tila/schemas";
import { defineCommand } from "citty";
import { findConfig, findTilaDir } from "../config";

/**
 * Resolve the credential provider config from the instance's trusted registry
 * record OR fall back to the project auth.mode.
 *
 * The untrusted project config can NEVER yield exec or oidc-generic — those
 * require an explicit trusted-registry entry (SC#1 trust boundary).
 */
function resolveProviderConfig(
  authMode: string,
  instanceCredentialProvider: CredentialProviderConfig | undefined,
): CredentialProviderConfig | null {
  // If the instance has an explicit credential_provider in the trusted registry, use it.
  if (instanceCredentialProvider !== undefined) {
    return instanceCredentialProvider;
  }

  // Fall back to project auth.mode — only the two non-privileged kinds are allowed.
  switch (authMode) {
    case "github-repo":
      return { kind: "github" };
    case "tila-token":
      return { kind: "tila-token" };
    default:
      // Unknown auth mode — default to tila-token
      return { kind: "tila-token" };
  }
}

/**
 * Check the exec trust gate: exec is only allowed when the resolver's
 * TrustDecision.kind === "trusted". Using the raw InstanceRecord.trust.trusted
 * boolean is INSUFFICIENT — it omits the CI fail-closed kinds
 * (ci-home-store-disabled / ci-tila-home-untrusted).
 */
function isExecTrusted(trustDecision: TrustDecision | null): boolean {
  if (trustDecision === null) return false;
  return trustDecision.kind === "trusted";
}

export default defineCommand({
  meta: {
    name: "init",
    description: "Join an existing tila project",
  },
  args: {
    token: {
      type: "string",
      description: "API token (tila-token mode)",
      required: false,
    },
  },
  async run({ args }) {
    const cwd = process.cwd();

    // Step 1: Find config
    const config = findConfig(cwd);
    if (!config) {
      p.log.error(
        "No project found. Run `tila project create` to create one, " +
          "or ask your admin to commit `.tila/config.toml`.",
      );
      process.exit(1);
    }

    p.log.info(`Project: ${config.project_id}`);

    const tilaDir = findTilaDir(cwd) ?? join(cwd, ".tila");

    // Step 2: Read auth mode
    const authMode = config.auth?.mode ?? "tila-token";

    // Step 2b: Attempt to read the instance's credential_provider from the trusted
    // registry. This requires the auth-store; if unavailable, fall back to auth.mode.
    let instanceCredentialProvider: CredentialProviderConfig | undefined;
    let instanceTrustDecision: TrustDecision | null = null;

    // Read instance record from the auth-store to get credential_provider override
    // and the resolver's TrustDecision (needed for the exec trust gate).
    try {
      const { AuthStore, TilaPaths, KeyringSecretStore, resolveWithTrace } =
        await import("@tila/auth-store");
      const { tilaHome } = await import("../lib/provisioning.js");
      void tilaHome(); // tilaHome() is referenced for TILA_HOME env var support
      const paths = new TilaPaths();
      const store = new AuthStore({
        paths,
        secrets: new KeyringSecretStore(),
        env: { isCI: processEnvProbe.isCI, isTTY: processEnvProbe.isTTY },
      });

      // Look up the instance via the config's instance pointer
      const rawConfig = config as Record<string, unknown>;
      const instanceSection = rawConfig.instance as
        | { key?: string }
        | undefined;
      const instanceKey = instanceSection?.key as string | undefined;

      if (instanceKey) {
        const { InstanceKey: InstanceKeySchema } = await import(
          "@tila/schemas"
        );
        const key = InstanceKeySchema.parse(instanceKey);
        const instanceRecord = await store.getInstance(key);
        if (instanceRecord) {
          instanceCredentialProvider = instanceRecord.credential_provider;

          // Get the trust decision via resolveWithTrace for the exec gate.
          // MUST use TrustDecision from the resolver, NOT the raw trust.trusted boolean.
          const outcome = await resolveWithTrace({
            envReader: (name) => process.env[name],
            env: {
              isCI: processEnvProbe.isCI,
              isTTY: processEnvProbe.isTTY,
              tilaHomeOverridden: !!process.env.TILA_HOME,
            },
            authStore: store,
            repoPointer: {
              instance_key: key,
              worker_url: instanceRecord.worker_url,
            },
          });
          if (outcome.ok) {
            instanceTrustDecision = outcome.instance.trust;
          } else {
            // Extract trust decision from trace if available
            const matchedStep = outcome.trace.find(
              (s) => s.matched && s.trust !== undefined,
            );
            instanceTrustDecision = matchedStep?.trust ?? null;
          }
        }
      }
    } catch {
      // Non-fatal: auth-store or keyring may be unavailable (e.g. keychain locked).
      // Fall back to auth.mode only.
    }

    // Step 3: Resolve provider config
    const providerConfig = resolveProviderConfig(
      authMode,
      instanceCredentialProvider,
    );

    if (!providerConfig) {
      p.log.error("Could not determine credential provider.");
      process.exit(1);
    }

    // Step 4: Exec trust gate (security-critical CI-1).
    // MUST use TrustDecision from the resolver, NOT the raw trust.trusted boolean.
    // The raw boolean omits CI fail-closed kinds (ci-home-store-disabled /
    // ci-tila-home-untrusted) which could allow exec provider in a hostile CI env.
    if (providerConfig.kind === "exec") {
      if (!isExecTrusted(instanceTrustDecision)) {
        p.log.error(
          `exec credential provider requires a trusted instance. The instance must be explicitly trusted (run \`tila auth login\`) and must not be in a CI fail-closed environment. TrustDecision: ${instanceTrustDecision?.kind ?? "none"}`,
        );
        process.exit(1);
      }
    }

    // Step 5: Pre-mint CI/non-TTY gate (single-owner — the post-mint putCredential
    // guard in AuthStore.putCredential remains as defense-in-depth).
    const envProbe = processEnvProbe;

    if (authMode === "github-repo" && providerConfig.kind === "github") {
      // Step 5a: github-repo flow — preserve existing behavior EXACTLY.
      // The full ladder (cache → GITHUB_TOKEN → gh auth token → device flow)
      // lives in resolveAppUserToken, called by resolveGithubRepoToken.
      // This path is byte-for-byte equivalent to the pre-WI-K behavior.
      // auth-store's github provider only does the device flow; the ladder is CLI-side.

      if (!config.worker_url) {
        p.log.error(
          "config.toml has no worker_url. Cannot join via GitHub auth.",
        );
        process.exit(1);
      }

      // Validate [github] section
      if (!config.github?.owner || !config.github?.repo) {
        p.log.error(
          'Auth mode is "github-repo" but [github] section is missing from .tila/config.toml. Add [github] with owner and repo fields.',
        );
        process.exit(1);
      }

      // Warn if --token flag was provided (ignored in github-repo mode)
      if (args.token) {
        p.log.warn(
          "Warning: --token flag is ignored in github-repo auth mode. Authentication uses GitHub device flow.",
        );
      }

      // Verify Worker health
      try {
        const resp = await fetch(
          `${config.worker_url.replace(/\/+$/, "")}/health`,
          {
            signal: AbortSignal.timeout(10_000),
          },
        );
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        p.log.info("Worker is reachable.");
      } catch (err) {
        p.log.error(
          `Worker unreachable at ${config.worker_url}/health: ${err instanceof Error ? err.message : String(err)}`,
        );
        process.exit(1);
      }

      // Resolve GitHub token and exchange for session
      const { resolveGithubRepoToken } = await import(
        "../lib/github-exchange.js"
      );
      const githubConfig = {
        ...config,
        worker_url: config.worker_url as string,
      };
      try {
        await resolveGithubRepoToken(githubConfig, tilaDir);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("GitHub App not configured")) {
          p.log.error(
            "GitHub App not configured for this project. Ask the project admin to set up the GitHub App first.",
          );
        } else {
          p.log.error(msg);
        }
        process.exit(1);
      }

      p.log.success("Authenticated via GitHub.");
    } else if (providerConfig.kind === "tila-token") {
      // Step 5b: tila-token flow
      const { writeTokenFile } = await import("../auth.js");
      let token = args.token;
      if (!token) {
        const result = await p.password({ message: "API token:" });
        if (p.isCancel(result)) process.exit(1);
        token = result;
      }
      if (!token || token.trim().length === 0) {
        p.log.error("No token provided. Aborting.");
        process.exit(1);
      }
      token = token.trim();

      writeTokenFile(token, tilaDir);
      p.log.info("Token written to .tila/.env (mode 0o600).");

      // Verify Worker health
      if (config.worker_url) {
        try {
          const resp = await fetch(
            `${config.worker_url.replace(/\/+$/, "")}/health`,
            {
              signal: AbortSignal.timeout(10_000),
            },
          );
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          p.log.success("Worker reachable.");
        } catch (err) {
          p.log.warn(
            `Worker unreachable: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    } else if (
      providerConfig.kind === "oidc-generic" ||
      providerConfig.kind === "exec"
    ) {
      // Step 5c: Provider-abstraction path for oidc-generic and exec.
      // These require explicit trusted-registry entries (never from auth.mode fallback).

      // Pre-mint CI/non-TTY gate (single-owner)
      if (envProbe.isCI) {
        p.log.error(
          `The ${providerConfig.kind} credential provider cannot be used under CI. Use an explicit project token (TILA_TOKEN) instead.`,
        );
        process.exit(1);
      }
      if (!envProbe.isTTY) {
        p.log.error(
          `The ${providerConfig.kind} credential provider requires an interactive terminal. Set TILA_TOKEN for non-interactive environments.`,
        );
        process.exit(1);
      }

      if (!config.worker_url) {
        p.log.error("config.toml has no worker_url.");
        process.exit(1);
      }

      const { buildProviderPorts } = await import("../lib/providers-cli.js");
      const ports = buildProviderPorts();
      const provider = createProvider(providerConfig.kind);

      // Build ProviderContext — instance_key from the config's instance.key
      const { InstanceKey: InstanceKeySchema } = await import("@tila/schemas");
      const rawConfig = config as Record<string, unknown>;
      const instanceSection = rawConfig.instance as
        | { key?: string }
        | undefined;
      const instanceKeyStr = instanceSection?.key ?? "unknown";
      const instanceKey = InstanceKeySchema.parse(instanceKeyStr);

      const ctx = {
        instance_key: instanceKey,
        worker_url: config.worker_url as string,
        ports,
        config: providerConfig,
      };

      let minted: Awaited<ReturnType<typeof provider.mint>>;
      try {
        minted = await provider.mint(ctx);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        p.log.error(`Credential acquisition failed: ${msg}`);
        process.exit(1);
      }

      // Token acquired — signal success
      // Full AuthStore.putCredential persistence is done via the auth login flow;
      // init confirms the credential works.
      p.log.success(
        `Authenticated via ${providerConfig.kind} provider. Token acquired.`,
      );
    } else {
      p.log.error(
        `Unsupported credential provider kind: ${(providerConfig as { kind: string }).kind}`,
      );
      process.exit(1);
    }

    // Step 6: Update .gitignore
    const { ensureGitignored } = await import("../lib/provisioning.js");
    ensureGitignored(
      [".tila/.env", ".tila/.session", ".tila/github-token-cache.json"],
      cwd,
    );

    // Step 7: MCP setup
    const { runMcpInitPrompt } = await import("../lib/mcp-targets.js");
    await runMcpInitPrompt(cwd);

    p.log.success("Project initialized. Ready to use tila.");
    p.log.info(
      "Tip: run `tila link <worker_url>` to store credentials in the OS keychain for multi-instance auth.",
    );
  },
});
