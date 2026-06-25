/**
 * `tila auth` command — manages CLI authentication credentials.
 *
 * Subcommands:
 *   recover  Regenerate the DPoP keypair and re-bind to a fresh session.
 */

import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import * as p from "@clack/prompts";
import { FakeSecretStore } from "@tila/auth-store";
import { defineCommand } from "citty";
import { findConfig, findTilaDir } from "../config";
import { generateDpopKey } from "../lib/dpop-key";
import { resolveGithubRepoToken } from "../lib/github-exchange";

export default defineCommand({
  meta: { name: "auth", description: "Manage CLI authentication credentials" },
  subCommands: {
    recover: defineCommand({
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
    }),
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
