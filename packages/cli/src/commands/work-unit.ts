import { defineCommand } from "citty";
import taskCommand from "./task";

// @deprecated — use `tila task` instead. This alias will be removed in a future release.
export default defineCommand({
  meta: {
    name: "work-unit",
    description: "Deprecated alias for `tila task`. Use `tila task` instead.",
  },
  setup() {
    console.warn(
      "Warning: `tila work-unit` is deprecated. Use `tila task` instead.",
    );
  },
  subCommands: taskCommand.subCommands,
});
