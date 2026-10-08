import { cli, define } from "gunshi";
import { plugin } from "gunshi/plugin";
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
const globals = plugin({
  id: "tila:context",
  name: "Tila context",
  setup(ctx) {
    for (const [name, schema] of Object.entries(common))
      ctx.addGlobalOption(name, schema);
  },
});

export async function trial(argv: string[]) {
  const make = (name: keyof typeof definitions) =>
    define({
      name,
      description: name,
      args: definitions[name],
      async run(ctx) {
        const values = ctx.values as SignalArgs;
        // No singleton: invocation identity/context is available through Gunshi values.
        await withOutput(
          {
            json: values.json === true,
            mutating: !["inbox", "history", "groupList", "groupGet"].includes(
              name,
            ),
          },
          () => signalHandlers[name](values, context(values)),
        );
      },
    });
  await cli(
    argv,
    define({ name: "signal", description: "Signal parity trial" }),
    {
      name: "tila-signal-trial",
      usageSilent: true,
      renderHeader: null,
      renderValidationErrors: null,
      plugins: [globals],
      strict: true,
      subCommands: {
        send: make("send"),
        inbox: make("inbox"),
        history: make("history"),
        ack: make("ack"),
        group: define({
          name: "group",
          description: "Groups",
          subCommands: {
            list: make("groupList"),
            get: make("groupGet"),
            set: make("groupSet"),
            delete: make("groupDelete"),
          },
        }),
      },
    },
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
