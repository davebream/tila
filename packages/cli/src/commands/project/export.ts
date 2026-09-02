import { isAbsolute } from "node:path";
import * as p from "@clack/prompts";
import { defineCommand } from "citty";
import { type ProjectBackupSource, exportProjectBackup } from "tila-sdk/backup";
import { requireTokenAsync } from "../../auth";
import { findConfig } from "../../config";
import { printJson } from "../../lib/output";

export default defineCommand({
  meta: {
    name: "export",
    description: "Create a complete checksummed project backup",
  },
  args: {
    output: {
      type: "string",
      description: "Absolute .tila-backup output path",
      required: true,
    },
    json: {
      type: "boolean",
      description: "Output machine-readable JSON",
      default: false,
    },
  },
  async run({ args }) {
    if (!isAbsolute(args.output))
      throw new Error("--output must be an absolute path");
    const config = findConfig();
    if (!config) throw new Error("No tila project found");
    let source: ProjectBackupSource;
    if (config.backend === "local") {
      if (!config.local?.db_path || !config.local.artifacts_path)
        throw new Error("Local project paths are missing");
      source = {
        backend: "local",
        projectId: config.project_id,
        dbPath: config.local.db_path,
        artifactsPath: config.local.artifacts_path,
        productVersion: config.tila_version,
        schemaVersion: config.schema_version,
      };
    } else {
      if (!config.worker_url)
        throw new Error("Cloud project worker_url is missing");
      source = {
        backend: "cloud",
        projectId: config.project_id,
        baseUrl: config.worker_url,
        token: await requireTokenAsync(),
        cloudflareAccountId: config.cloudflare?.account_id,
      };
    }
    const spinner = args.json ? null : p.spinner();
    spinner?.start("Freezing writes and exporting project...");
    const manifest = await exportProjectBackup({ source, output: args.output });
    spinner?.stop("Backup verified and project unlocked.");
    const result = {
      ok: true,
      output: args.output,
      project_id: manifest.project_id,
      ...manifest.stats,
    };
    if (args.json) printJson(result);
    else
      p.note(
        `Rows: ${manifest.stats.rows}\nBlobs: ${manifest.stats.objects}\nBytes: ${manifest.stats.archive_bytes}\nElapsed: ${manifest.stats.elapsed_ms} ms\nOutput: ${args.output}`,
        "Project backup complete",
      );
  },
});
