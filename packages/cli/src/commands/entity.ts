import { defineCommand } from "citty";
import taskCommand from "./task";

// @deprecated — use `tila task` instead. This alias will be removed in a future release.
export default defineCommand({
  meta: {
    name: "entity",
    description: "Deprecated alias for `tila task`. Use `tila task` instead.",
  },
  setup() {
    console.warn(
      "Warning: `tila entity` is deprecated. Use `tila task` instead.",
    );
  },
  subCommands: taskCommand.subCommands,
});
