import { defineCommand } from "citty";
import { createProjectMethods } from "tila-sdk";
import { requireClient, resolveContext } from "../../context";
import { globalFlagArgs } from "../../lib/global-flags";
import { printJson } from "../../lib/output";

export default defineCommand({
  meta: {
    name: "settings",
    description: "Show the project display name and its revision",
  },
  args: globalFlagArgs,
  async run() {
    const ctx = await resolveContext();
    printJson(
      await createProjectMethods(
        requireClient(ctx),
        ctx.config.project_id,
      ).settings(),
    );
  },
});
