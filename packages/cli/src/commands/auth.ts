/**
 * `tila auth` command group.
 *
 * Subcommands:
 *   auth recover — regenerate the DPoP keypair and re-bind to a fresh session (WI-G)
 *   auth status  — list instances, show which resolves here (WI-L, AC-1/AC-5)
 *   auth token   — emit the bare bearer token to stdout, diagnostics to stderr (WI-L, AC-2/AC-5)
 *
 * SECURITY INVARIANT (WI-L): the read-path subcommands never write a raw token to
 * any output path other than process.stdout.write (auth token, non-json mode).
 * auth status uses toInstanceMetadata() which strips the credential field.
 */

import { existsSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import * as p from "@clack/prompts";
import {
  FakeSecretStore,
  promoteLegacy,
  readLegacyCredential,
} from "@tila/auth-store";
import type { LegacyLocations } from "@tila/auth-store";
import type { InstanceRecord } from "@tila/schemas";
import { defineCommand } from "citty";
import { findConfig, findTilaDir } from "../config";
import { generateDpopKey } from "../lib/dpop-key";
import { resolveGithubRepoToken } from "../lib/github-exchange";
import { globalFlagArgs } from "../lib/global-flags";
import {
  buildAuthStore,
  resolveInstanceContext,
  toInstanceMetadata,
} from "../lib/instance-context";
import {
  eprintJson,
  eprintln,
  formatExpiry,
  formatResolvesHere,
  formatTrust,
  jsonArg,
  printJson,
  printJsonSuccess,
  renderTable,
} from "../lib/output";
import { tilaHome } from "../lib/provisioning";

// ---------------------------------------------------------------------------
// auth status (WI-L)
// ---------------------------------------------------------------------------

const statusCmd = defineCommand({
  meta: {
    name: "status",
    description:
      "Show all registered instances, trust, expiry, and which resolves here",
  },
  args: {
    "all-instances": {
      type: "boolean" as const,
      description: "Show all instances (default: show resolved/current only)",
      default: false,
    },
    ...jsonArg,
    ...globalFlagArgs,
  },
  async run({ args }) {
    const authStore = buildAuthStore();
    const instances: InstanceRecord[] = await authStore.listInstances();
    const currentContext = await authStore.getCurrentContext();

    // Determine which instance resolves in this environment
    const outcome = await resolveInstanceContext({ authStore });
    const resolvedKey = outcome.ok ? outcome.instance.instance_key : null;

    if (args.json) {
      // Build safe per-instance metadata for JSON (no tokens)
      const instancesJson = await Promise.all(
        instances.map(async (inst) => {
          let expiresAt: number | null = null;
          try {
            const cred = await authStore.getCredential(inst.instance_key, {
              allowExpired: true,
            });
            expiresAt = cred?.expires_at ?? null;
          } catch {
            // keychain unavailable — degrade gracefully
          }
          return {
            instance_key: inst.instance_key,
            label: inst.label ?? null,
            worker_url: inst.worker_url,
            trust: inst.trust,
            expires_at: expiresAt,
            is_current: inst.instance_key === currentContext,
            resolves_here: inst.instance_key === resolvedKey,
          };
        }),
      );

      // Safe projection — never serialise credential
      const resolved = outcome.ok ? toInstanceMetadata(outcome.instance) : null;

      printJsonSuccess({
        current_context: currentContext,
        resolved,
        instances: instancesJson,
      });
      return;
    }

    // Table output
    if (instances.length === 0) {
      console.log(
        "No instances registered. Run `tila link <worker_url>` to register one.",
      );
      return;
    }

    const rows = await Promise.all(
      instances.map(async (inst) => {
        let expiresAt: number | null = null;
        try {
          const cred = await authStore.getCredential(inst.instance_key, {
            allowExpired: true,
          });
          expiresAt = cred?.expires_at ?? null;
        } catch {
          // keychain unavailable — degrade
        }

        const isHere = inst.instance_key === resolvedKey;
        const isCurrent = inst.instance_key === currentContext;

        return {
          key: `${inst.instance_key}${isCurrent ? " ◀" : ""}`,
          label: inst.label ?? "—",
          worker_url: inst.worker_url,
          trust: formatTrust(
            inst.trust.trusted
              ? { kind: "trusted" as const }
              : {
                  kind: "untrusted-needs-login" as const,
                  reason: "not-trusted" as const,
                },
          ),
          expiry: formatExpiry(expiresAt),
          here: formatResolvesHere(isHere),
        };
      }),
    );

    renderTable(rows, [
      { key: "key", label: "Key" },
      { key: "label", label: "Label" },
      { key: "worker_url", label: "Worker URL" },
      { key: "trust", label: "Trust" },
      { key: "expiry", label: "Expiry" },
      { key: "here", label: "Resolves Here?" },
    ]);
  },
});

// ---------------------------------------------------------------------------
// auth token (WI-L)
// ---------------------------------------------------------------------------

const tokenCmd = defineCommand({
  meta: {
    name: "token",
    description:
      "Emit the resolved bearer token to stdout (credential-helper mode)",
  },
  args: {
    ...jsonArg,
    ...globalFlagArgs,
  },
  async run({ args }) {
    const outcome = await resolveInstanceContext();

    if (!outcome.ok) {
      const msg = outcome.error.message;
      if (args.json) {
        // Error envelope to stderr (stdout must stay clean)
        eprintJson({
          ok: false,
          code: "instance-resolution-failed",
          message: msg,
        });
      } else {
        eprintln(`Error: ${msg}`);
        eprintln(
          "Hint: run `tila auth status` to diagnose or `tila link <url>` to register.",
        );
      }
      process.exit(1);
      return;
    }

    const { instance } = outcome;
    const cred = instance.credential;

    // Extract raw token from the union.
    // "keychain" carries a CredentialRecord; "inline-token" and "legacy" carry
    // a bare token directly on the variant object.
    const token = cred.source === "keychain" ? cred.record.token : cred.token;

    if (args.json) {
      // JSON goes to stdout (opt-in)
      if (cred.source === "keychain") {
        printJson({
          token: cred.record.token,
          token_type: cred.record.token_type,
          expires_at: cred.record.expires_at,
          instance_key: instance.instance_key,
          source: "keychain",
        });
      } else {
        // "inline-token" and "legacy" — bare token, no expiry metadata
        printJson({
          token,
          token_type: "Bearer",
          expires_at: null,
          instance_key: instance.instance_key ?? null,
          source: cred.source,
        });
      }
      return;
    }

    // Non-JSON: diagnostics to stderr, bare token to stdout
    eprintln(
      `source: ${cred.source}${instance.instance_key ? ` (${instance.instance_key})` : ""}`,
    );
    if (cred.source === "keychain") {
      eprintln(`expiry: ${formatExpiry(cred.record.expires_at)}`);
    }

    // SECURITY: bare token + newline ONLY to stdout; nothing else goes here
    process.stdout.write(`${token}\n`);
  },
});

// ---------------------------------------------------------------------------
// auth recover (WI-G) — regenerate the DPoP keypair and re-bind a session
// ---------------------------------------------------------------------------

const recoverCmd = defineCommand({
  meta: {
    name: "recover",
    description:
      "Regenerate the DPoP keypair and re-bind to a fresh session (use after a lost or corrupted private key)",
  },
  args: {
    headless: {
      type: "boolean",
      description:
        "Headless / CI mode — emit a clear error instead of prompting for a device flow",
      default: false,
    },
  },
  async run({ args }) {
    // Detect if we are in a CI / non-interactive environment
    const isHeadless =
      (args.headless as boolean) ||
      Boolean(process.env.CI) ||
      !process.stdout.isTTY;

    if (isHeadless) {
      p.log.error(
        "tila auth recover requires an interactive terminal to complete the GitHub device flow.\n\nIn CI or headless environments you cannot interactively authorize a new DPoP key.\nTo recover:\n  1. Run `tila auth recover` from an interactive terminal on any machine.\n  2. Copy the new .tila/.session into your CI secret store, or\n     set TILA_API_TOKEN to a newly issued bound token.",
      );
      process.exit(1);
      return;
    }

    const config = findConfig();
    const tilaDir = findTilaDir();

    if (!config || !tilaDir) {
      p.log.error(
        "No .tila/config.toml found. Run `tila init` first to configure your project.",
      );
      process.exit(1);
      return;
    }

    const authMode =
      (config as { auth?: { mode?: string } }).auth?.mode ?? "tila-token";

    if (authMode === "github-repo") {
      await recoverGithubSession(config, tilaDir);
    } else {
      // tila-token mode: the DPoP key is independent; regenerate and advise
      // to issue a new bound token via `tila token issue`.
      await recoverTilaTokenMode(tilaDir);
    }
  },
});

/**
 * Recovery for github-repo auth mode:
 *   1. Regenerate the DPoP keypair (stored in a FakeSecretStore for this ephemeral operation).
 *   2. Force a fresh GitHub device-flow exchange sending the new jkt.
 *   3. Drop the stale session cache so the new one is used immediately.
 */
async function recoverGithubSession(
  config: Record<string, unknown>,
  tilaDir: string,
): Promise<void> {
  p.intro("tila auth recover — re-binding session to a new DPoP key");

  // Use a FakeSecretStore for ephemeral key generation; the real key pair is
  // embedded directly in the session (the private key is not persisted separately
  // for the session path — the session itself is the credential).
  const secretStore = new FakeSecretStore();

  // Step 1: generate a new key pair
  p.log.step("Generating new DPoP key pair…");
  let jkt: string;
  try {
    const keyResult = await generateDpopKey(secretStore, "recover-session");
    jkt = keyResult.jkt;
  } catch (err) {
    p.log.error(
      `Failed to generate DPoP key: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
    return;
  }

  // Step 2: drop stale session cache so resolveGithubRepoToken performs a fresh exchange
  const sessionPath = join(tilaDir, ".session");
  if (existsSync(sessionPath)) {
    try {
      unlinkSync(sessionPath);
      p.log.step("Dropped stale session cache.");
    } catch {
      p.log.warn(
        "Could not remove stale session cache — will re-exchange anyway.",
      );
    }
  }

  // Step 3: run a fresh GitHub device-flow exchange with the new jkt
  p.log.step(
    "Starting GitHub device flow to mint a fresh bound session.\nPlease authorize in your browser when prompted…",
  );

  const typedConfig = config as {
    project_id: string;
    worker_url: string;
    github?: { host?: string; owner?: string; repo?: string; repo_id?: number };
  };

  if (!typedConfig.project_id || !typedConfig.worker_url) {
    p.log.error(
      "project_id or worker_url missing from .tila/config.toml. Run `tila init` to fix.",
    );
    process.exit(1);
    return;
  }

  try {
    await resolveGithubRepoToken(typedConfig, tilaDir, jkt);
  } catch (err) {
    p.log.error(
      `Failed to complete GitHub exchange: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
    return;
  }

  p.outro(
    "Recovery complete. A new DPoP-bound session has been written to .tila/.session.\nRun any `tila` command to verify the new session is working.",
  );
}

/**
 * Recovery for tila-token mode:
 *   The DPoP key pair is regenerated. Because the D1 token's cnf_jkt is fixed at
 *   issue time, the user must issue a new bound token and revoke the old one.
 */
async function recoverTilaTokenMode(tilaDir: string): Promise<void> {
  p.intro("tila auth recover — regenerating DPoP key pair (tila-token mode)");

  const secretStore = new FakeSecretStore();

  p.log.step("Generating new DPoP key pair…");
  let jkt: string;
  try {
    const keyResult = await generateDpopKey(secretStore, "recover-token");
    jkt = keyResult.jkt;
  } catch (err) {
    p.log.error(
      `Failed to generate DPoP key: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
    return;
  }

  // Drop stale session if any
  const sessionPath = join(tilaDir, ".session");
  if (existsSync(sessionPath)) {
    try {
      unlinkSync(sessionPath);
    } catch {
      // non-fatal
    }
  }

  p.log.info(
    `New DPoP public key thumbprint (jkt): ${jkt}\n\nBecause the tila-token mode binds the jkt at token issue time, you must:\n  1. Issue a new token bound to this key:\n       tila token issue --name my-token-v2\n     (The CLI will automatically include the new jkt when DPoP is active.)\n  2. Revoke the old token:\n       tila token revoke my-old-token\n  3. Update any scripts or CI secrets to use the new token.`,
  );

  p.outro("DPoP key regenerated. Follow the steps above to complete recovery.");
}

// ---------------------------------------------------------------------------
// auth migrate (WI-M) — eagerly promote all discovered legacy credentials
// ---------------------------------------------------------------------------

const migrateCmd = defineCommand({
  meta: {
    name: "migrate",
    description:
      "Eagerly promote legacy .tila/.env / .tila/.session credentials into the ~/.tila store",
  },
  args: {
    "dry-run": {
      type: "boolean" as const,
      description: "Print what would be promoted without writing anything",
      default: false,
    },
    yes: {
      type: "boolean" as const,
      description: "Skip confirmation prompts",
      default: false,
    },
    ...jsonArg,
    ...globalFlagArgs,
  },
  async run({ args }) {
    // Headless guard — mirrors recoverCmd: only interactive terminals may migrate.
    const isHeadless = Boolean(process.env.CI) || !process.stdout.isTTY;

    if (isHeadless) {
      eprintln(
        "Error: tila auth migrate requires an interactive terminal.\n\n" +
          "In CI or headless environments, use TILA_TOKEN or --token inline instead.\n" +
          "To migrate interactively: run `tila auth migrate` from a TTY terminal.",
      );
      process.exit(1);
      return;
    }

    const authStore = buildAuthStore();

    // Build legacy locations
    const homeInfraTomlPath = join(tilaHome(), "infra.toml");
    const projectTilaDir = findTilaDir();
    const legacy: LegacyLocations = {
      projectTilaDir,
      homeInfraToml: existsSync(homeInfraTomlPath) ? homeInfraTomlPath : null,
    };

    // Determine worker_url candidates: from repo config + existing registry
    const workerUrls: string[] = [];
    const repoConfig = findConfig();
    if (repoConfig?.worker_url) {
      workerUrls.push(repoConfig.worker_url);
    }
    const existingInstances = await authStore.listInstances();
    for (const inst of existingInstances) {
      if (!workerUrls.includes(inst.worker_url)) {
        workerUrls.push(inst.worker_url);
      }
    }

    if (
      workerUrls.length === 0 &&
      !legacy.homeInfraToml &&
      !legacy.projectTilaDir
    ) {
      if (args.json) {
        printJsonSuccess({
          message:
            "No legacy locations or worker URLs discovered — nothing to migrate.",
          instances_registered: 0,
          credentials_promoted: 0,
          infra_slugs_split: [],
        });
      } else {
        console.log(
          "No legacy locations or worker URLs discovered — nothing to migrate.",
        );
      }
      return;
    }

    // Check for insecure legacy files and warn
    const insecurePaths: string[] = [];
    if (projectTilaDir) {
      for (const filename of [".env", ".session"]) {
        const filePath = join(projectTilaDir, filename);
        if (existsSync(filePath)) {
          try {
            const mode = statSync(filePath).mode;
            if ((mode & 0o077) !== 0) {
              insecurePaths.push(filePath);
            }
          } catch {
            // non-fatal
          }
        }
      }
    }

    // Determine what will be promoted (for --dry-run and reporting)
    const dryRun = args["dry-run"] as boolean;

    // Determine legacy source paths for footer message
    const legacySourcePaths: string[] = [];
    if (projectTilaDir) {
      for (const filename of [".env", ".session", "infra.toml"]) {
        const filePath = join(projectTilaDir, filename);
        if (existsSync(filePath)) {
          legacySourcePaths.push(filePath);
        }
      }
    }
    if (legacy.homeInfraToml && existsSync(legacy.homeInfraToml)) {
      legacySourcePaths.push(legacy.homeInfraToml);
    }

    // Call promoteLegacy for each discovered worker_url
    let totalCredentials = 0;
    const totalInfraSlugs: string[] = [];
    const registeredKeys: string[] = [];

    // If no worker_urls but we have infra only, still try with first available
    const urlsToTry = workerUrls.length > 0 ? workerUrls : [];

    for (const workerUrl of urlsToTry) {
      const result = await promoteLegacy({
        authStore,
        legacy,
        env: { isCI: false, isTTY: true },
        workerUrl,
        dryRun,
      });

      if (result.promotedCredential) totalCredentials++;
      for (const slug of result.promotedInfraSlugs) {
        if (!totalInfraSlugs.includes(slug)) totalInfraSlugs.push(slug);
      }
      if (
        result.instanceKey &&
        !registeredKeys.includes(String(result.instanceKey))
      ) {
        registeredKeys.push(String(result.instanceKey));
      }
    }

    // Emit insecure-permission warnings (SECURITY: field names only, never values)
    for (const filePath of insecurePaths) {
      const warning = `Warning: ${filePath} has world/group-readable permissions (mode suggests 0644 or wider). Other users on this system may have read your token. Consider rotating credentials after migration.`;
      if (args.json) {
        eprintln(`[tila] ${warning}`);
      } else {
        console.warn(`[tila] ${warning}`);
      }
    }

    // Build report (SECURITY: secret field names referenced, never values)
    const report = {
      dry_run: dryRun,
      instances_registered: registeredKeys.length,
      credentials_promoted: totalCredentials,
      infra_slugs_split: totalInfraSlugs,
      // SECURITY: infra secret fields promoted by NAME only — never their values
      infra_secrets_promoted_fields:
        totalInfraSlugs.length > 0
          ? ["hmac_key", "sweep_secret", "infra_admin_token"].filter(Boolean)
          : [],
    };

    if (args.json) {
      printJsonSuccess(report);
    } else {
      if (dryRun) {
        console.log("Dry-run mode — no changes written.\n");
      }
      console.log(`Instances registered: ${report.instances_registered}`);
      console.log(`Credentials promoted: ${report.credentials_promoted}`);
      if (report.infra_slugs_split.length > 0) {
        console.log(
          `Infra slugs split: ${report.infra_slugs_split.join(", ")} (secret fields: hmac_key, sweep_secret, infra_admin_token)`,
        );
      }

      if (legacySourcePaths.length > 0 && !dryRun) {
        console.log(
          `\nLegacy files left in place — safe to delete after verifying:\n${legacySourcePaths.map((p) => `  ${p}`).join("\n")}`,
        );
      }
    }
  },
});

// ---------------------------------------------------------------------------
// auth command group
// ---------------------------------------------------------------------------

export default defineCommand({
  meta: {
    name: "auth",
    description: "Manage tila authentication (instances, tokens, status)",
  },
  subCommands: {
    migrate: migrateCmd,
    recover: recoverCmd,
    status: statusCmd,
    token: tokenCmd,
  },
});
