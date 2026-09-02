import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import * as p from "@clack/prompts";
import { defineCommand } from "citty";
import {
  type ProjectBackupDestination,
  importProjectBackup,
  inspectProjectBackup,
} from "tila-sdk/backup";
import { requireTokenAsync } from "../../auth";
import { findConfig } from "../../config";
import { printJson } from "../../lib/output";
import { tilaHome } from "../../lib/provisioning";

function latestSafetyArchive(archive: string, projectId: string): string {
  const suffix = `-${projectId}-pre-restore.tila-backup`;
  const candidates = readdirSync(dirname(archive))
    .filter((name) => name.endsWith(suffix))
    .sort()
    .reverse();
  if (!candidates[0])
    throw new Error(`No adjacent safety backup found for ${projectId}`);
  return join(dirname(archive), candidates[0]);
}

export default defineCommand({
  meta: { name: "import", description: "Restore a complete project backup" },
  args: {
    archive: {
      type: "positional",
      description: ".tila-backup archive",
      required: true,
    },
    replace: {
      type: "boolean",
      description: "Replace an existing project after creating a safety backup",
      default: false,
    },
    force: {
      type: "boolean",
      description: "Skip typed slug confirmation",
      default: false,
    },
    resume: {
      type: "boolean",
      description: "Resume the matching interrupted restore",
      default: false,
    },
    rollback: {
      type: "boolean",
      description: "Restore the latest adjacent safety backup",
      default: false,
    },
    local: {
      type: "boolean",
      description:
        "Create a new local destination when no project config exists",
      default: false,
    },
    json: {
      type: "boolean",
      description: "Output machine-readable JSON",
      default: false,
    },
  },
  async run({ args }) {
    if (!existsSync(args.archive))
      throw new Error(`Backup archive does not exist: ${args.archive}`);
    const initial = await inspectProjectBackup(args.archive);
    const config = findConfig();
    const existing = config !== null;
    if (existing && !args.replace && !args.resume && !args.rollback) {
      throw new Error("The destination already exists; pass --replace");
    }
    if (existing && !args.force && !args.resume) {
      const answer = await p.text({
        message: `Type "${initial.manifest.project_id}" to confirm replacement:`,
        validate: (value) =>
          value === initial.manifest.project_id
            ? undefined
            : `Expected "${initial.manifest.project_id}"`,
      });
      if (p.isCancel(answer) || answer !== initial.manifest.project_id) {
        p.cancel("Restore cancelled.");
        return;
      }
    }
    const archive = args.rollback
      ? latestSafetyArchive(args.archive, initial.manifest.project_id)
      : args.archive;
    let destination: ProjectBackupDestination;
    if (config?.backend === "local" || (!config && args.local)) {
      const projectId = initial.manifest.project_id;
      destination =
        config?.backend === "local"
          ? {
              backend: "local",
              projectId,
              dbPath: config.local?.db_path ?? "",
              artifactsPath: config.local?.artifacts_path ?? "",
              productVersion: config.tila_version,
              schemaVersion: config.schema_version,
            }
          : {
              backend: "local",
              projectId,
              dbPath: join(tilaHome(), "projects", projectId, "state.db"),
              artifactsPath: join(tilaHome(), "artifacts", "local", projectId),
            };
    } else if (config) {
      if (!config.worker_url)
        throw new Error("Cloud project worker_url is missing");
      destination = {
        backend: "cloud",
        projectId: config.project_id,
        baseUrl: config.worker_url,
        token: await requireTokenAsync(),
        cloudflareAccountId: config.cloudflare?.account_id,
      };
    } else {
      throw new Error(
        "No destination project found; pass --local to create a local project or initialize cloud infrastructure",
      );
    }
    const spinner = args.json ? null : p.spinner();
    spinner?.start("Verifying archive and restoring project...");
    const result = await importProjectBackup({
      archive,
      destination,
      replace: existing || args.replace,
      resume: args.resume,
      rollback: args.rollback,
    });
    spinner?.stop("Restore verified and project unlocked.");
    const output = {
      ok: true,
      project_id: result.manifest.project_id,
      safety_backup: result.safetyBackup,
      bootstrap_token: result.bootstrapToken,
      ...result.manifest.stats,
    };
    if (args.json) printJson(output);
    else
      p.note(
        `Project: ${result.manifest.project_id}\nRows: ${result.manifest.stats.rows}\nBytes: ${result.manifest.stats.archive_bytes}${result.safetyBackup ? `\nSafety backup: ${result.safetyBackup}` : ""}`,
        "Project restore complete",
      );
  },
});
