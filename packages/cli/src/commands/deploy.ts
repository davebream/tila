import { createPrivateKey } from "node:crypto";
import { defineCommand } from "citty";
import { createCloudflareClient } from "../lib/cloudflare-client";
import {
  applyD1Migrations,
  setWorkerSecrets,
} from "../lib/cloudflare-resources";
import type { MigrationResult } from "../lib/d1-migrations";
import {
  type DeployPayloadSummary,
  type DeployResult,
  deployWorkerWithAssets,
  describeDeployPayload,
  describeUiOutcome,
} from "../lib/deploy";
import { loadGithubAppCredentials } from "../lib/github-app-setup";
import { getInfraSlug, loadInfraConfig } from "../lib/infra-config";
import { exit, jsonArg, printJson, printJsonError } from "../lib/output";

import * as p from "../lib/prompts";
import {
  resolveCfApiToken,
  resolveMigrationsDir,
  tilaHome,
} from "../lib/provisioning";
import { R2_BUCKET_NAME } from "../lib/resource-names";

export default defineCommand({
  meta: {
    name: "deploy",
    description:
      "Deploy Worker and UI to Cloudflare via wrangler. Exit codes: 0 success, 1 deploy failed.",
  },
  args: {
    "skip-ui": {
      type: "boolean",
      description:
        "Skip UI deployment (deploy Worker code only, no [assets] block)",
      default: false,
    },
    migrate: {
      type: "boolean",
      description:
        "Apply pending D1 migrations before deployment (--no-migrate checks only and refuses pending files)",
      default: true,
    },
    "dry-run": {
      type: "boolean",
      description:
        "Check the Worker, UI and D1 migrations a deploy would upload, without contacting Cloudflare",
      default: false,
    },
    ...jsonArg,
  },
  async run({ args }) {
    const json = args.json === true;
    const tilaDir = tilaHome();

    function fatal(message: string, code: string): never {
      if (json) printJsonError(message, code);
      p.cancel(message);
      exit(1);
    }

    if (args["dry-run"]) {
      let summary: DeployPayloadSummary;
      try {
        summary = describeDeployPayload();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        fatal(`Deploy payload check failed: ${msg}`, "DEPLOY_PAYLOAD_INVALID");
      }
      if (json) {
        printJson(summary);
        return;
      }
      p.note(
        `Version:    ${summary.version} (${summary.source})\n` +
          `Worker:     ${summary.worker}\n` +
          `UI:         ${summary.ui.indexHtml ? `${summary.ui.files} files` : "built during deploy"} (${summary.ui.dir})\n` +
          `D1:         ${summary.migrations.count} migrations, latest ${summary.migrations.latest}`,
        "Deploy payload OK (dry run, nothing deployed)",
      );
      return;
    }

    let infraConfig: ReturnType<typeof loadInfraConfig>;
    try {
      infraConfig = loadInfraConfig(tilaDir);
    } catch {
      fatal(
        "No infra.toml found. Run `tila infra provision` first.",
        "NO_INFRA_CONFIG",
      );
    }

    const cfToken = resolveCfApiToken();
    if (!cfToken) {
      fatal(
        "No CLOUDFLARE_API_TOKEN found in environment or ~/.tila/.env.\n\n" +
          "Set the token via `export CLOUDFLARE_API_TOKEN=...` or in ~/.tila/.env.",
        "NO_CF_TOKEN",
      );
    }

    const cf = createCloudflareClient(cfToken);
    const scriptName = getInfraSlug(infraConfig);
    const r2BucketName = infraConfig.r2_bucket_name ?? R2_BUCKET_NAME;

    const s = json ? null : p.spinner();
    s?.start("Checking D1 migrations...");

    let result: DeployResult;
    let migrations: MigrationResult;
    try {
      migrations = await applyD1Migrations(
        cf,
        infraConfig.account_id,
        infraConfig.d1_database_id,
        resolveMigrationsDir(),
        { migrate: args.migrate !== false, quiet: json },
      );
      s?.message("Deploying Worker and UI...");
      result = await deployWorkerWithAssets({
        cf,
        accountId: infraConfig.account_id,
        scriptName,
        d1DatabaseId: infraConfig.d1_database_id,
        r2BucketName,
        apiToken: cfToken,
        skipUi: args["skip-ui"],
      });

      const secrets: Record<string, string> = {};
      if (infraConfig.hmac_key) {
        secrets.GITHUB_SESSION_HMAC_KEY = infraConfig.hmac_key;
      }
      const creds = loadGithubAppCredentials(tilaDir);
      if (creds) {
        secrets.GITHUB_APP_ID = String(creds.app_id);
        const key = createPrivateKey({ key: creds.pem, format: "pem" });
        secrets.GITHUB_APP_PRIVATE_KEY = key.export({
          type: "pkcs8",
          format: "pem",
        }) as string;
        secrets.GITHUB_APP_CLIENT_ID = creds.client_id;
        secrets.GITHUB_APP_CLIENT_SECRET = creds.client_secret;
      }
      if (Object.keys(secrets).length > 0) {
        await setWorkerSecrets(cf, infraConfig.account_id, scriptName, secrets);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (json) printJsonError(`Deploy failed: ${msg}`, "DEPLOY_FAILED");
      s?.stop("Deploy failed.");
      p.cancel(`Deploy failed: ${msg}`);
      exit(1);
    }

    if (json) {
      printJson({ workerUrl: result.workerUrl, ui: result.ui, migrations });
      return;
    }

    const { spinnerMessage, uiLine } = describeUiOutcome(result.ui);
    s?.stop(spinnerMessage);
    p.note(
      `Worker:  ${result.workerUrl}\n${uiLine}\nD1:      ${migrations.watermark ?? "none"} (${migrations.applied} applied)`,
      "Deploy complete",
    );
  },
});
