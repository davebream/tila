import tab from "@bomb.sh/tab/citty";
import { type ArgsDef, type CommandDef, renderUsage, runCommand } from "citty";
import {
  collectionCap,
  collectionDefault,
  commandArgs,
  describeCommands,
  errorDefinitions,
  groups,
  isMutating,
  isProtocol,
  materialize,
  resolveInvocation,
  sharedArgs,
} from "./command-registry";
import { setGlobalFlags } from "./global-flags";
import {
  failWithCliError,
  outputText,
  printJson,
  rawOutput,
  withOutput,
} from "./output";

export async function runCli(
  root: CommandDef,
  argv: string[],
  version: string,
): Promise<void> {
  // Root parsing failures must honor JSON too. Values containing '=--json' are not flags.
  const delimiter = argv.indexOf("--");
  const flags = delimiter < 0 ? argv : argv.slice(0, delimiter);
  let json =
    flags.filter((x) => /^--json(?:=|$)/.test(x)).at(-1) !== undefined &&
    flags.filter((x) => /^--json(?:=|$)/.test(x)).at(-1) !== "--json=false";
  try {
    const invocation = await resolveInvocation(root, argv);
    json = invocation.globals.json === true;
    const { path, globals, help, rest } = invocation;
    if (path === "complete" && !help) {
      if (
        rest[0] !== "--" &&
        !["bash", "zsh", "fish", "powershell"].includes(rest[0])
      )
        throw Object.assign(
          new Error("Use tila complete bash|zsh|fish|powershell"),
          { code: "invalid-argument" },
        );
      const tree = await materialize(root);
      await tab(tree);
      await runCommand(tree, { rawArgs: ["complete", ...rest] });
      return;
    }
    setGlobalFlags({
      instance: globals.instance as string | undefined,
      token: globals.token as string | undefined,
      project: globals.project as string | undefined,
      participantId: globals["participant-id"] as string | undefined,
    });
    const limitArg = rest.find((x) => x.startsWith("--limit="))?.slice(8);
    let limit =
      limitArg === undefined ? collectionDefault(path) : Number(limitArg);
    if (
      limit !== undefined &&
      (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
    )
      throw Object.assign(
        new Error(
          "--limit must be an integer from 1 to 1000 (backend limits may be lower)",
        ),
        { code: "invalid-argument" },
      );
    if (limit !== undefined) {
      limit = Math.min(limit, collectionCap(path));
      if (limitArg !== undefined)
        rest.splice(
          rest.findIndex((x) => x.startsWith("--limit=")),
          1,
          `--limit=${limit}`,
        );
    }
    for (const name of ["offset", "before-revision"]) {
      const value = rest.find((x) => x.startsWith(`--${name}=`))?.split("=")[1];
      if (
        value !== undefined &&
        (!Number.isSafeInteger(Number(value)) ||
          Number(value) < (name === "offset" ? 0 : 1))
      )
        throw Object.assign(
          new Error(
            `--${name} must be a ${name === "offset" ? "nonnegative" : "positive"} integer`,
          ),
          { code: "invalid-argument" },
        );
    }
    const run = async () => {
      if (!path && rest.length === 1 && ["--version", "-v"].includes(rest[0])) {
        if (json) printJson({ version });
        else outputText(version);
        return;
      }
      if (path === "schema" && !help) {
        const filterIndex = rest.indexOf("--command");
        const filter =
          rest.find((x) => x.startsWith("--command="))?.slice(10) ??
          (filterIndex >= 0 ? rest[filterIndex + 1] : undefined);
        if (rest.length && filter === undefined)
          throw Object.assign(
            new Error(
              "Use tila schema --command 'task list' to filter CLI introspection",
            ),
            { code: "invalid-argument" },
          );
        const commands = await describeCommands(await materialize(root));
        const selected = filter
          ? commands.filter(
              (row) =>
                row.name === filter ||
                String(row.name).startsWith(`${filter} `),
            )
          : commands;
        if (filter && !selected.length)
          throw Object.assign(new Error(`Unknown command path '${filter}'`), {
            code: "unknown-command",
          });
        printJson({
          clispec: "0.2",
          name: "tila",
          version,
          command_layout: "flat",
          output: { tty: "text", piped: "text" },
          global_args: Object.entries(sharedArgs).map(([name, arg]) => ({
            name: `--${name}`,
            ...arg,
          })),
          commands: selected,
          errors: errorDefinitions,
        });
        return;
      }
      if (!path) {
        if (json) {
          printJson({ version, groups });
          return;
        }
        outputText(`tila ${version}\n\nUsage: tila <command> [options]\n`);
        for (const [group, names] of Object.entries(groups))
          outputText(`${group}\n  ${names.join("  ")}\n`);
        outputText(
          "Global options: --json --non-interactive --instance --project --token --participant-id\nUse tila schema for offline command introspection, or tila <command> --help.",
        );
        return;
      }
      const cmd = invocation.cmd;
      const args: ArgsDef = await commandArgs(cmd, path);
      if (!help)
        for (const [name, value] of Object.entries(globals))
          args[name] = { ...args[name], default: value } as ArgsDef[string];
      const prepared: CommandDef = { ...cmd, args };
      if (help || (!cmd.run && cmd.subCommands)) {
        if (json)
          printJson({
            commands: await describeCommands(
              await materialize(prepared, path),
              path,
            ),
          });
        else outputText(await renderUsage(prepared));
        return;
      }
      await runCommand(prepared, { rawArgs: rest });
    };
    if (isProtocol(path)) {
      if (path === "lifecycle worker") {
        try {
          await run();
        } catch {
          process.exitCode = 1;
        }
      } else await run();
    } else
      await withOutput(
        {
          json,
          nonInteractive: globals["non-interactive"] === true,
          mutating: isMutating(path),
          limit,
        },
        async () => {
          try {
            await run();
          } catch (error) {
            failWithCliError(error, json);
          }
        },
      );
  } catch (error) {
    failWithCliError(error, json);
  }
}
