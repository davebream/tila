import { defineCommand } from "citty";
import taskCommand from "./task";

// @deprecated — use `tila task` instead. This alias will be removed in a future release.
export default defineCommand({
  meta: {
    name: "entity",
    description: "Deprecated alias for `tila task`. Use `tila task` instead.",
  },
  setup() {
    // Route console.warn to stderr only when not in --json mode (C2).
    // Citty's setup() runs before args are parsed, so we check process.argv directly.
    // This prevents the deprecation warning from interleaving with structured JSON output.
    if (!process.argv.includes("--json")) {
      console.warn(
        "Warning: `tila entity` is deprecated. Use `tila task` instead.",
      );
    }
  },
  subCommands: taskCommand.subCommands,
});
