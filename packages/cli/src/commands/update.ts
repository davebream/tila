import { writeSync } from "node:fs";
import { CliUpdateResultSchema } from "@tila/schemas";
import { defineCommand } from "citty";
import { performUpdate, resultText } from "../../bin/update.mjs";
import {
  currentOutput,
  diagnostic,
  jsonArg,
  outputText,
  printJson,
  rawOutput,
} from "../lib/output";
import { VERSION } from "../version";

// Bun replaces this constant for each release target. It is deliberately
// absent in source development, where process.execPath belongs to Bun/Node.
declare const TILA_BUILD_TARGET: string | undefined;

export default defineCommand({
  meta: {
    name: "update",
    description: "Update the installed tila CLI to the latest stable release",
  },
  args: {
    ...jsonArg,
    check: {
      type: "boolean",
      default: false,
      description: "Check for an update without installing it",
    },
  },
  async run({ args }) {
    const output = currentOutput();
    if (output) output.mutating = !args.check;
    const response = await performUpdate({
      current: VERSION,
      target:
        typeof TILA_BUILD_TARGET === "undefined"
          ? undefined
          : TILA_BUILD_TARGET,
      launcherRoot: process.env.TILA_UPDATE_LAUNCHER,
      check: args.check,
      progress: diagnostic,
    });
    if (response.handoff) {
      if (process.env.TILA_UPDATE_PIPE !== "3")
        throw new Error(
          "The npm launcher cannot complete this update. Reinstall tila-cli with its package manager.",
        );
      writeSync(
        3,
        `${JSON.stringify({ ...(response.handoff as object), json: args.json })}\n`,
      );
      // The parent launcher emits the final result after the native child exits.
      rawOutput("");
      return;
    }
    const result = CliUpdateResultSchema.parse(response.result);
    if (args.json) printJson(result);
    else outputText(resultText(result));
  },
});
