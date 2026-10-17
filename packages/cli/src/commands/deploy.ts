import type { DeployTarget } from "@tila/schemas";
import { defineCommand } from "citty";
import { createCloudflareClient } from "../lib/cloudflare-client";
import { applyD1Migrations } from "../lib/cloudflare-resources";
import type { MigrationResult } from "../lib/d1-migrations";
import {
  type DeployPayloadSummary,
  type DeployResult,
  deployWorkerWithAssets,
  describeDeployPayload,
  describeUiOutcome,
} from "../lib/deploy";
import { DeployTargetError, resolveDeployTarget } from "../lib/deploy-target";
import {
  DeploymentSettingsError,
  describeDeploymentSettings,
} from "../lib/deployment-settings";
import { getGlobalFlags, globalFlagArgs } from "../lib/global-flags";
import { buildAuthStore } from "../lib/instance-context";
import {
  diagnostic,
  exit,
  jsonArg,
  printJson,
  printJsonError,
} from "../lib/output";
import { detectWrangler } from "../lib/wrangler-cli";

import * as p from "../lib/prompts";
import {
  resolveCfApiToken,
  resolveMigrationsDir,
  tilaHome,
} from "../lib/provisioning";

export default defineCommand({
  meta: {
    name: "deploy",
    description:
      "Deploy Worker and UI to Cloudflare via wrangler. Exit codes: 0 success, 1 deploy failed.",
  },
  args: {
    infra: {
      type: "string",
      description:
        "Select saved infrastructure by slug (overrides ambient instance context)",
    },
    instance: globalFlagArgs.instance,
    project: globalFlagArgs.project,
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

    const cfToken = resolveCfApiToken();
    if (!cfToken) {
      fatal(
        "No CLOUDFLARE_API_TOKEN found in environment or ~/.tila/.env.\n\n" +
          "Set the token via `export CLOUDFLARE_API_TOKEN=...` or in ~/.tila/.env.",
        "NO_CF_TOKEN",
      );
    }

    const cf = createCloudflareClient(cfToken);
    let target: DeployTarget;
    try {
      await detectWrangler();
      target = await resolveDeployTarget({
        cf,
        store: buildAuthStore(),
        home: tilaDir,
        infra: args.infra,
        instance: args.instance ?? getGlobalFlags().instance,
        project: args.project ?? getGlobalFlags().project,
        inlineToken: Boolean(getGlobalFlags().token),
      });
    } catch (error) {
      fatal(
        error instanceof Error ? error.message : "Target verification failed.",
        error instanceof DeployTargetError ||
          error instanceof DeploymentSettingsError
          ? error.code
          : "DEPLOY_TARGET_UNVERIFIED",
      );
    }
    const targetTitle = `Deployment target (${target.source}): ${target.infraSlug}`;
    const targetDetails =
      `Account: ${target.accountName} (${target.accountId})\n` +
      `Worker: ${target.scriptName}${target.workerUrl ? ` (${target.workerUrl})` : ""}\n` +
      `D1: ${target.d1DatabaseId}\nR2: ${target.r2BucketName}\n${describeDeploymentSettings(target.settings)}`;
    if (json) diagnostic(`${targetTitle}\n${targetDetails}`);
    else p.note(targetDetails, targetTitle);

    const s = json ? null : p.spinner();
    s?.start("Checking D1 migrations...");

    let result: DeployResult;
    let migrations: MigrationResult;
    try {
      migrations = await applyD1Migrations(
        cf,
        target.accountId,
        target.d1DatabaseId,
        resolveMigrationsDir(),
        { migrate: args.migrate !== false, quiet: json },
      );
      s?.message("Deploying Worker and UI...");
      result = await deployWorkerWithAssets({
        cf,
        accountId: target.accountId,
        scriptName: target.scriptName,
        d1DatabaseId: target.d1DatabaseId,
        r2BucketName: target.r2BucketName,
        apiToken: cfToken,
        skipUi: args["skip-ui"],
        settings: target.settings,
        workerUrl: target.workerUrl,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (json) printJsonError(`Deploy failed: ${msg}`, "DEPLOY_FAILED");
      s?.stop("Deploy failed.");
      p.cancel(`Deploy failed: ${msg}`);
      exit(1);
    }

    if (json) {
      printJson({
        workerUrl: result.workerUrl,
        ui: result.ui,
        migrations,
        target,
      });
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
