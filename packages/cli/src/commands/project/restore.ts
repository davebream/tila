import { defineCommand } from "citty";
import { planProjectRecovery, restoreProjectCheckpoint } from "tila-sdk/backup";
import { checkpointSource } from "../../lib/checkpoint";
import { printJson } from "../../lib/output";
import * as p from "../../lib/prompts";

export default defineCommand({
  meta: {
    name: "restore",
    description:
      "Recover a cloud project from a verified checkpoint, preserving current access",
  },
  args: {
    directory: {
      type: "string",
      required: true,
      description: "Absolute checkpoint directory",
    },
    to: {
      type: "string",
      description:
        "ISO-8601 time with timezone; select the latest checkpoint at or before it",
    },
    resume: {
      type: "string",
      description: "Resume this recovery operation ID",
    },
    rollback: {
      type: "string",
      description:
        "Roll back this interrupted operation ID to its safety archive",
    },
    "dry-run": {
      type: "boolean",
      default: false,
      description:
        "Verify and show the recovery selection without modifying the project",
    },
    force: {
      type: "boolean",
      default: false,
      description: "Skip typed project confirmation",
    },
    json: {
      type: "boolean",
      default: false,
      description: "Output machine-readable JSON",
    },
  },
  async run({ args }) {
    const source = await checkpointSource();
    const plan = await planProjectRecovery({
      source,
      directory: args.directory,
      to: args.to,
      resume: args.resume,
      rollback: args.rollback,
    });
    const recoveryTarget =
      plan.action === "rollback"
        ? `safety archive ${plan.safety_backup}`
        : `checkpoint ${plan.checkpoint.snapshot_at}`;
    if (args["dry-run"]) {
      if (args.json) printJson({ dry_run: true, ...plan });
      else
        p.note(
          `Requested: ${plan.requested_at}\nTarget: ${recoveryTarget}\nArchive: ${plan.action === "rollback" ? plan.safety_backup : plan.archive}\nAction: ${plan.action}`,
          "Recovery preview",
        );
      return;
    }
    if (!args.force) {
      const answer = await p.text({
        message: `Restore ${recoveryTarget}. Type "${source.projectId}" to confirm:`,
        validate: (value) =>
          value === source.projectId
            ? undefined
            : `Expected "${source.projectId}"`,
      });
      if (p.isCancel(answer) || answer !== source.projectId) {
        p.cancel("Restore cancelled.");
        return;
      }
    }
    try {
      const result = await restoreProjectCheckpoint({ source, plan });
      if (args.json) printJson(result);
      else
        p.note(
          `Recovered snapshot: ${result.actual_time ?? "safety archive"}\nOperation: ${result.operation_id}\nSafety backup: ${result.safety_backup}`,
          "Recovery verified",
        );
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : "Recovery failed"}\nOperation: ${plan.operation_id}. Resume with --resume ${plan.operation_id} or roll back with --rollback ${plan.operation_id}, using the same --directory.`,
        { cause: error },
      );
    }
  },
});
