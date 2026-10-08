import { type CommandDef, runCommand } from "citty";
import {
  type SignalArgs,
  signalHandlers,
} from "../../packages/cli/src/commands/signal";
import {
  failWithCliError,
  flushOutput,
  withOutput,
} from "../../packages/cli/src/lib/output";
import { common, context, definitions } from "./fixture";
export async function trial(argv: string[]) {
  const leaf = (name: keyof typeof definitions): CommandDef => ({
    meta: { name, description: name },
    args: Object.fromEntries(
      Object.entries({ ...common, ...definitions[name] }).map(
        ([key, value]) => [key, { ...value, type: value.type }],
      ),
    ),
    async run({ args }) {
      await withOutput(
        {
          json: args.json === true,
          mutating: !["inbox", "history", "groupList", "groupGet"].includes(
            name,
          ),
        },
        () =>
          signalHandlers[name](args as SignalArgs, context(args as SignalArgs)),
      );
    },
  });
  await runCommand(
    {
      args: common,
      subCommands: {
        send: leaf("send"),
        inbox: leaf("inbox"),
        history: leaf("history"),
        ack: leaf("ack"),
        group: {
          subCommands: {
            list: leaf("groupList"),
            get: leaf("groupGet"),
            set: leaf("groupSet"),
            delete: leaf("groupDelete"),
          },
        },
      },
    },
    { rawArgs: argv },
  );
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  try {
    await trial(argv);
    await flushOutput();
  } catch (error) {
    failWithCliError(error, argv.includes("--json"));
  }
}
