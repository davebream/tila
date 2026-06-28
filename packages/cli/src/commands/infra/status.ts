import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import * as p from "@clack/prompts";
import { defineCommand } from "citty";
import { createCloudflareClient } from "../../lib/cloudflare-client";
import { queryD1 } from "../../lib/cloudflare-resources";
import { resolveInfraConfig } from "../../lib/infra-fallback";
import { buildAuthStore } from "../../lib/instance-context";
import { printJson, printJsonError } from "../../lib/output";
import { resolveCfApiToken, tilaHome } from "../../lib/provisioning";
import { R2_BUCKET_NAME } from "../../lib/resource-names";

export default defineCommand({
  meta: {
    name: "status",
    description: "Show account-level tila infrastructure status",
  },
  args: {
    json: {
      type: "boolean",
      description: "Output status as JSON",
      default: false,
    },
  },
  async run({ args }) {
    const tilaDir = tilaHome();

    // Step 1: Load infra config — prefer per-slug store, fall back to flat file
    let config: Awaited<ReturnType<typeof resolveInfraConfig>>;
    try {
      config = await resolveInfraConfig(tilaDir, buildAuthStore());
    } catch (err) {
      if (args.json) {
        printJsonError("No infrastructure found", "NOT_CONFIGURED");
      }
      p.cancel("No infrastructure found. Run `tila infra provision` first.");
      process.exit(1);
    }

    // Step 4: D1 project count (shared between JSON and interactive paths)
    let projectCount: number | null = null;
    const cfToken = resolveCfApiToken();
    if (cfToken) {
      try {
        const cf = createCloudflareClient(cfToken);
        const rows = await queryD1<{ cnt: number }>(
          cf,
          config.account_id,
          config.d1_database_id,
          "SELECT COUNT(*) as cnt FROM _projects",
        );
        projectCount = rows[0]?.cnt ?? 0;
      } catch {
        // non-fatal — leave as null
      }
    }

    // Step 5: File inventory
    const files = ["infra.toml", "github-app.json", ".env"];
    const fileEntries: Record<string, string> = {};
    for (const file of files) {
      const filePath = join(tilaDir, file);
      if (existsSync(filePath)) {
        try {
          const stat = statSync(filePath);
          fileEntries[file] = stat.mtime.toLocaleDateString();
        } catch {
          fileEntries[file] = "present";
        }
      }
    }

    // JSON output path
    if (args.json) {
      const statusObj = {
        account: { id: config.account_id, name: config.account_name },
        d1: { database_id: config.d1_database_id },
        r2: { bucket_name: config.r2_bucket_name ?? R2_BUCKET_NAME },
        worker: { url: config.worker_url ?? null },
        pages: {
          project_name: config.pages_project_name ?? null,
          url: config.pages_project_name
            ? `https://${config.pages_project_name}.pages.dev`
            : null,
        },
        github_app: config.github_app ?? null,
        projects: projectCount ?? null,
        files: fileEntries,
      };
      printJson(statusObj);
      return;
    }

    // Step 2: Build summary lines (interactive path)
    const lines: string[] = [
      `Account:   ${config.account_name}`,
      `ID:        ${config.account_id}`,
      `D1:        ${config.d1_database_id}`,
    ];

    // Step 3: Pages project info
    if (config.pages_project_name) {
      lines.push(
        `Pages:     https://${config.pages_project_name}.pages.dev (${config.pages_project_name})`,
      );
    } else {
      lines.push("Pages:     not configured");
    }

    // Step 3b: GitHub App info
    if (config.github_app) {
      const githubAppJsonPath = join(tilaDir, "github-app.json");
      const credStatus = existsSync(githubAppJsonPath)
        ? "credentials present"
        : "credentials MISSING";
      lines.push(
        `GitHub:    app=${config.github_app.app_id}, install=${config.github_app.installation_id} (${credStatus})`,
      );
    } else {
      lines.push("GitHub:    not configured");
    }

    if (projectCount !== null) {
      lines.push(`Projects:  ${projectCount}`);
    }

    const fileLines = Object.entries(fileEntries).map(
      ([file, date]) => `${file}: ${date}`,
    );
    if (fileLines.length > 0) {
      lines.push(`Files:     ${fileLines[0]}`);
      for (let i = 1; i < fileLines.length; i++) {
        lines.push(`           ${fileLines[i]}`);
      }
    }

    p.note(lines.join("\n"), "Infrastructure Status");
  },
});
