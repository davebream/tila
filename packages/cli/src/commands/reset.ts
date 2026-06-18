import { defineCommand } from "citty";
import { z } from "zod";
import { requireClient, resolveContext } from "../context";
import { jsonArg, printJson, printJsonError } from "../lib/output";

const ResetResponseSchema = z.object({
  ok: z.literal(true),
});

export default defineCommand({
  meta: { name: "reset", description: "Reset all project data" },
  args: {
    confirm: {
      type: "boolean",
      description: "Skip confirmation prompt",
      default: false,
    },
    ...jsonArg,
  },
  async run({ args }) {
    if (!args.confirm) {
      if (args.json) {
        printJsonError(
          "Reset requires --confirm flag",
          "CONFIRMATION_REQUIRED",
        );
      }
      console.error(
        "This will DELETE ALL project data. Run with --confirm to proceed.",
      );
      process.exit(1);
    }
    const ctx = await resolveContext();
    if (ctx.config.backend === "local") {
      if (args.json) {
        printJsonError(
          "This command requires a remote connection (tila init)",
          "REMOTE_ONLY",
        );
      } else {
        console.error(
          "Error: this command requires a remote connection (tila init)",
        );
      }
      process.exit(1);
    }
    const client = requireClient(ctx);
    await client.post(
      "/api/reset",
      {},
      { schema: ResetResponseSchema, validate: true },
    );
    if (args.json) {
      printJson({ ok: true });
      return;
    }
    console.log("Project data reset successfully.");
  },
});
