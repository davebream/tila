import { defineCommand } from "citty";
import { createProjectMethods } from "tila-sdk";
import { requireClient, resolveContext } from "../../context";
import { expectedRevision, revisionArgs } from "../../lib/expected-revision";
import { globalFlagArgs } from "../../lib/global-flags";
import { printJson } from "../../lib/output";

export default defineCommand({
  meta: {
    name: "rename",
    description:
      "Change the display name (owner); the project ID and routing never change",
  },
  args: {
    ...globalFlagArgs,
    ...revisionArgs,
    name: {
      type: "positional",
      required: false,
      description: "New display name; omit with --clear",
    },
    clear: { type: "boolean", default: false },
  },
  async run({ args }) {
    if (!args.name === !args.clear)
      throw new Error("Pass a new name or --clear");
    const ctx = await resolveContext();
    const api = createProjectMethods(requireClient(ctx), ctx.config.project_id);
    const expected = await expectedRevision(
      args,
      async () => (await api.settings()).settings.revision,
    );
    printJson(
      await api.rename(args.clear ? null : String(args.name), expected),
    );
  },
});
