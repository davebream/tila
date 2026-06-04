import { join } from "node:path";
import * as p from "@clack/prompts";
import { defineCommand } from "citty";
import { createCloudflareClient } from "../../lib/cloudflare-client";
import { queryD1 } from "../../lib/cloudflare-resources";
import { loadInfraConfig } from "../../lib/infra-config";
import { resolveCfApiToken, tilaHome } from "../../lib/provisioning";

export default defineCommand({
  meta: {
    name: "list",
    description: "List tila projects",
  },
  async run() {
    // Step 1: Read infra.toml
    const homeDir = tilaHome();
    let infraConfig: ReturnType<typeof loadInfraConfig>;
    try {
      infraConfig = loadInfraConfig(homeDir);
    } catch {
      p.cancel("No infrastructure found. Run `tila infra provision` first.");
      process.exit(1);
    }

    // Step 2: Resolve CF token
    const apiToken = resolveCfApiToken();
    if (!apiToken) {
      p.cancel(
        "CLOUDFLARE_API_TOKEN not found. Set it in ~/.tila/.env or export it.",
      );
      process.exit(1);
    }

    // Step 3: Query D1
    const cf = createCloudflareClient(apiToken);
    const projects = await queryD1<{
      project_id: string;
      display_name: string;
      created_at: string;
    }>(
      cf,
      infraConfig.account_id,
      infraConfig.d1_database_id,
      "SELECT project_id, display_name, created_at FROM _projects ORDER BY created_at DESC",
    );

    if (projects.length === 0) {
      p.log.info("No projects found.");
      return;
    }

    const lines = projects.map((project) => {
      const id = String(project.project_id ?? "unknown");
      const displayName = project.display_name
        ? String(project.display_name)
        : "";
      const label =
        displayName && displayName !== id ? `${id} (${displayName})` : id;
      const createdAt = project.created_at
        ? new Date(Number(project.created_at) * 1000).toLocaleDateString()
        : "unknown";
      return `${label}  (created: ${createdAt})`;
    });
    p.note(lines.join("\n"), `${projects.length} project(s)`);
  },
});
