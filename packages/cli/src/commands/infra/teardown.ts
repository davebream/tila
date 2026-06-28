import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import * as p from "@clack/prompts";
import { defineCommand } from "citty";
import { createCloudflareClient } from "../../lib/cloudflare-client";
import { deletePagesProject, queryD1 } from "../../lib/cloudflare-resources";
import type { AppCredentials } from "../../lib/github-app-setup";
import { getInfraSlug } from "../../lib/infra-config";
import { resolveInfraConfig } from "../../lib/infra-fallback";
import { buildAuthStore } from "../../lib/instance-context";
import { printJsonError } from "../../lib/output";
import { resolveCfApiToken, tilaHome } from "../../lib/provisioning";
import { R2_BUCKET_NAME } from "../../lib/resource-names";
import {
  deleteD1Database,
  deleteGitHubApp,
  deleteR2Bucket,
  deleteWorker,
  findNonEmptyR2Prefix,
} from "../../lib/teardown";

export default defineCommand({
  meta: {
    name: "teardown",
    description: "Tear down account-level tila infrastructure",
  },
  args: {
    yes: {
      type: "boolean",
      description:
        "Skip all confirmation prompts — requires CLOUDFLARE_API_TOKEN in environment",
      default: false,
    },
  },
  async run({ args }) {
    const tilaDir = tilaHome();

    if (args.yes && !resolveCfApiToken()) {
      printJsonError(
        "CLOUDFLARE_API_TOKEN required with --yes",
        "MISSING_TOKEN",
      );
    }

    // Step 1: Load infra config — prefer per-slug store, fall back to flat file
    let config: Awaited<ReturnType<typeof resolveInfraConfig>>;
    try {
      config = await resolveInfraConfig(tilaDir, buildAuthStore());
    } catch (err) {
      p.cancel("No infrastructure found. Run `tila infra provision` first.");
      process.exit(1);
    }

    // Step 2: Resolve CF token — prompt if not found (skip in --yes mode)
    let cfToken = resolveCfApiToken();
    if (!cfToken && !args.yes) {
      const tokenResult = await p.password({
        message: "Paste your CLOUDFLARE_API_TOKEN:",
      });
      if (p.isCancel(tokenResult)) {
        p.cancel("Operation cancelled.");
        process.exit(1);
      }
      cfToken = String(tokenResult ?? "").trim();
      if (!cfToken) {
        p.cancel("No token provided. Aborting.");
        process.exit(1);
      }
    }

    if (!cfToken) {
      p.cancel("No CLOUDFLARE_API_TOKEN available. Aborting.");
      process.exit(1);
    }

    const cf = createCloudflareClient(cfToken);

    // Step 3: Confirmation gate — user must type "teardown <account_name>" (skip in --yes mode)
    if (!args.yes) {
      const confirmText = `teardown ${config.account_name}`;
      p.log.warn(
        `This will permanently destroy ALL account-level tila infrastructure for "${config.account_name}".`,
      );
      const answer = await p.text({
        message: `Type "${confirmText}" to confirm:`,
        validate: (value) => {
          if (value !== confirmText) return `Expected "${confirmText}"`;
        },
      });
      if (p.isCancel(answer)) {
        p.cancel("Teardown cancelled.");
        process.exit(1);
      }
      if (answer !== confirmText) {
        p.log.error(
          `Confirmation failed. Expected "${confirmText}", got "${answer}".`,
        );
        process.exit(1);
      }
    }

    // Step 4: Check D1 has zero remaining projects
    const rows = await queryD1<{ cnt: number }>(
      cf,
      config.account_id,
      config.d1_database_id,
      "SELECT COUNT(*) as cnt FROM _projects",
    );
    const projectCount = rows[0]?.cnt ?? 0;

    if (projectCount > 0) {
      p.log.error(
        `D1 database still has ${projectCount} project(s). Destroy all projects first with \`tila project destroy\`.`,
      );
      process.exit(1);
    }

    // Step 4b: Check R2 bucket is empty before proceeding
    // Coordination: a companion epic (infra-teardown-fails-to-delete-non-empty-r2-bucket)
    // tracks adding a `tila infra r2-gc` repair command for orphaned blobs.
    const r2BucketNameForCheck = config.r2_bucket_name ?? R2_BUCKET_NAME;
    let nonEmptyPrefix: string | null = null;
    try {
      nonEmptyPrefix = await findNonEmptyR2Prefix(
        cf,
        config.account_id,
        r2BucketNameForCheck,
      );
    } catch (err) {
      // If the bucket does not exist yet (404), treat as empty and continue.
      if ((err as { status?: number }).status !== 404) {
        p.log.warn(
          `R2 empty-check failed (${err instanceof Error ? err.message : String(err)}) — proceeding anyway.`,
        );
      }
    }
    if (nonEmptyPrefix !== null) {
      p.log.error(
        `R2 bucket "${r2BucketNameForCheck}" still has objects under prefix "${nonEmptyPrefix}". Destroy all projects first with \`tila project destroy\` to remove artifact blobs.`,
      );
      process.exit(1);
    }

    // Step 5a: Delete Pages project (if configured)
    const s = p.spinner();
    if (config.pages_project_name) {
      s.start("Deleting Pages project...");
      try {
        await deletePagesProject(
          cf,
          config.account_id,
          config.pages_project_name,
        );
        s.stop("Pages project deleted.");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        s.stop(`Pages project deletion failed (continuing): ${msg}`);
      }
    }

    // Step 5b: Delete Worker
    s.start("Deleting Worker...");
    const workerResult = await deleteWorker(
      cf,
      config.account_id,
      getInfraSlug(config),
    );
    s.stop(
      workerResult.ok ? "Worker deleted." : `Worker: ${workerResult.message}`,
    );

    // Step 5b: Delete R2 bucket
    const r2BucketName = config.r2_bucket_name ?? R2_BUCKET_NAME;
    s.start("Deleting R2 bucket...");
    const r2Result = await deleteR2Bucket(cf, config.account_id, r2BucketName);
    s.stop(r2Result.ok ? "R2 bucket deleted." : `R2: ${r2Result.message}`);

    // Step 5c: Delete D1 database
    s.start("Deleting D1 database...");
    const d1Result = await deleteD1Database(
      cf,
      config.account_id,
      config.d1_database_id,
    );
    s.stop(d1Result.ok ? "D1 database deleted." : `D1: ${d1Result.message}`);

    // Step 6: Delete GitHub App if configured
    let manualDeleteUrl: string | null = null;
    if (config.github_app) {
      const githubAppJsonPath = join(tilaDir, "github-app.json");
      if (existsSync(githubAppJsonPath)) {
        try {
          const creds = JSON.parse(
            readFileSync(githubAppJsonPath, "utf-8"),
          ) as AppCredentials;

          s.start("Removing GitHub App installations...");
          const ghResult = await deleteGitHubApp(creds);
          s.stop("GitHub App installations removed.");

          const urlMatch = ghResult.message.match(
            /(https:\/\/github\.com\/settings\/apps\/\S+)/,
          );
          if (urlMatch) manualDeleteUrl = urlMatch[1];
        } catch (err) {
          p.log.error(
            `Failed to read github-app.json: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      } else {
        manualDeleteUrl = "https://github.com/settings/apps";
        p.log.warn(
          "github-app.json not found — skipping installation removal.",
        );
      }
    }

    // Step 7: Delete files from ~/.tila/
    const filesToDelete = ["infra.toml", "github-app.json", ".env"];
    const deleted: string[] = [];
    const failed: string[] = [];
    for (const file of filesToDelete) {
      const filePath = join(tilaDir, file);
      if (existsSync(filePath)) {
        try {
          unlinkSync(filePath);
          deleted.push(file);
        } catch {
          failed.push(file);
        }
      }
    }
    if (deleted.length > 0) {
      p.log.info(`Cleaned ~/.tila/ (${deleted.join(", ")})`);
    }
    if (failed.length > 0) {
      p.log.warn(`Failed to delete: ${failed.join(", ")}`);
    }

    if (manualDeleteUrl) {
      if (args.yes) {
        p.log.info(`Delete the GitHub App at: ${manualDeleteUrl}`);
      } else {
        const openIt = await p.confirm({
          message: `Open GitHub to delete the App? (${manualDeleteUrl})`,
        });
        if (!p.isCancel(openIt) && openIt) {
          const { openInBrowser } = await import("../../lib/browser");
          openInBrowser(manualDeleteUrl);
        } else {
          p.log.warn(`Delete the GitHub App manually at: ${manualDeleteUrl}`);
        }
      }
    }

    p.log.success(
      "Account infrastructure torn down. To re-provision: tila infra provision",
    );
  },
});
