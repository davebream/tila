import { defineCommand } from "citty";
import {
  createProjectCheckpoint,
  listProjectCheckpoints,
} from "tila-sdk/backup";
import { checkpointSource } from "../../lib/checkpoint";
import { printJson } from "../../lib/output";
import * as p from "../../lib/prompts";

const args = {
  directory: {
    type: "string",
    required: true,
    description: "Absolute checkpoint directory",
  },
  json: {
    type: "boolean",
    default: false,
    description: "Output machine-readable JSON",
  },
} as const;

export default defineCommand({
  meta: {
    name: "checkpoint",
    description: "Create and inspect complete recovery checkpoints",
  },
  subCommands: {
    create: defineCommand({
      meta: {
        name: "create",
        description: "Capture a verified cloud project checkpoint",
      },
      args,
      async run({ args }) {
        const result = await createProjectCheckpoint({
          source: await checkpointSource(),
          directory: args.directory,
        });
        if (args.json) printJson({ ok: true, ...result });
        else
          p.note(
            `Time: ${result.checkpoint.snapshot_at}\nArchive: ${result.archive}`,
            "Checkpoint verified",
          );
      },
    }),
    list: defineCommand({
      meta: {
        name: "list",
        description: "Verify and list local checkpoint archives",
      },
      args,
      async run({ args }) {
        const checkpoints = await listProjectCheckpoints({
          directory: args.directory,
        });
        if (args.json) printJson({ checkpoints });
        else
          p.note(
            checkpoints
              .map(
                (entry) =>
                  `${entry.checkpoint?.snapshot_at ?? (entry.legacy ? "Legacy archive" : "Invalid")} ${entry.archive}${entry.error ? `: ${entry.error}` : ""}`,
              )
              .join("\n") || "No checkpoints",
            "Checkpoints",
          );
      },
    }),
  },
});
