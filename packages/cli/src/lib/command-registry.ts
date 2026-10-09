import type { ArgsDef, CommandDef } from "citty";
import { TILA_ERRORS } from "tila-sdk";
import { exitCodeFor } from "./exit-codes";
import { globalFlagArgs } from "./global-flags";
import { jsonArg } from "./output";

export const errorDefinitions = [
  ...new Set([
    ...Object.values(TILA_ERRORS),
    "invalid-argument",
    "unknown-command",
    "input-required",
    "partial-failure",
    "schema-apply-failed",
    "command-failed",
    "ERROR",
    "ARG_MISSING_REQUIRED",
    "network-error",
    "fetch-failed",
  ]),
]
  .sort()
  .map((kind) => ({
    kind,
    exit_code: exitCodeFor(kind),
    retryable: false,
    ...(exitCodeFor(kind) === 2
      ? { retryable_when: "read-only invocation; never a partial mutation" }
      : {}),
  }));

export const groups: Record<string, string[]> = {
  "Getting Started": [
    "init",
    "link",
    "open",
    "mcp",
    "lifecycle",
    "machine",
    "run",
  ],
  "Work and Coordination": [
    "task",
    "state",
    "presence",
    "signal",
    "summary",
    "gate",
  ],
  "Data and Schema": [
    "record",
    "artifact",
    "schema",
    "journal",
    "search",
    "index",
    "template",
  ],
  "Access and Instances": [
    "auth",
    "token",
    "service-account",
    "repos",
    "admin",
    "switch",
    "instances",
    "shell",
    "disconnect",
  ],
  "Infrastructure and Diagnostics": [
    "project",
    "infra",
    "deploy",
    "reset",
    "config",
    "doctor",
    "update",
    "complete",
  ],
};
export const aliases: Record<string, string> = {
  entity: "task",
  "work-unit": "task",
};
export const sharedArgs = {
  ...globalFlagArgs,
  ...jsonArg,
  "non-interactive": {
    type: "boolean" as const,
    description: "Never prompt for input",
    default: false,
  },
};

// Audited read-only operations. Unknown/new commands remain mutating until reviewed.
const readOnly = new Set([
  "machine list",
  "machine inspect",
  "run list",
  "run inspect",
  "schema",
  "complete",
  "task list",
  "task ready",
  "task get",
  "task tree",
  "task relationship list",
  "task artifact list",
  "record get",
  "record list",
  "record history",
  "record types",
  "record diff",
  "artifact list",
  "artifact history",
  "artifact refs",
  "artifact get",
  "artifact read",
  "artifact grep",
  "artifact search",
  "artifact reviews",
  "signal inbox",
  "signal history",
  "signal group get",
  "signal group list",
  "presence list",
  "state",
  "summary",
  "journal tail",
  "search",
  "search tasks",
  "search artifacts",
  "search all",
  "schema show",
  "schema status",
  "schema diff",
  "template list",
  "template show",
  "template diff",
  "token list",
  "gate list",
  "service-account list",
  "service-account workload list",
  "index list-entries",
  "token whoami",
  "auth status",
  "instances",
  "instances list",
  "config show",
  "project list",
  "project status",
  "project inspect",
  "infra status",
  "lifecycle status",
  "doctor",
]);
export function isMutating(path: string): boolean {
  // artifact get --output writes a local file, so metadata conservatively marks it mutating.
  return path === "artifact get" || !readOnly.has(path);
}
export function isProtocol(path: string): boolean {
  return (
    path === "lifecycle hook" ||
    path === "lifecycle worker" ||
    path === "complete"
  );
}

export async function resolveValue<T>(
  value: T | Promise<T> | (() => T | Promise<T>),
): Promise<T> {
  return typeof value === "function"
    ? (value as () => T | Promise<T>)()
    : await value;
}

export function collectionDefault(path: string): number | undefined {
  if (path === "artifact reviews" || path === "signal history") return 50;
  if (path === "record list") return 200;
  if (path === "artifact grep") return 50;
  if (
    path === "journal tail" ||
    path === "artifact history" ||
    path === "record history" ||
    path.startsWith("search") ||
    path === "artifact search"
  )
    return 20;
  return /(?:^| )(list|history|reviews|inbox|ready|refs|types)$/.test(path) ||
    [
      "instances",
      "repos",
      "presence",
      "state",
      "lifecycle status",
      "index list-entries",
    ].includes(path)
    ? 100
    : undefined;
}
export function collectionCap(path: string): number {
  if (["record list", "record history", "artifact history"].includes(path))
    return 200;
  if (
    path.startsWith("search") ||
    [
      "artifact search",
      "artifact grep",
      "signal history",
      "artifact reviews",
    ].includes(path)
  )
    return 100;
  return 1000;
}
export async function commandArgs(
  cmd: CommandDef,
  path: string,
): Promise<ArgsDef> {
  const args = await resolveValue(cmd.args ?? {});
  const limit = collectionDefault(path);
  return {
    ...sharedArgs,
    ...args,
    ...(limit
      ? {
          limit: {
            description: "Maximum results",
            ...args.limit,
            default: String(args.limit?.default ?? limit),
            type: "string",
          },
        }
      : {}),
    ...(path === "schema"
      ? {
          command: {
            type: "string",
            description: "Filter CLI introspection by command path",
          },
        }
      : {}),
  };
}

export async function materialize(
  cmd: CommandDef,
  path = "",
): Promise<CommandDef> {
  const meta = await resolveValue(cmd.meta ?? {});
  const args = await resolveValue(cmd.args ?? {});
  const children = await resolveValue(cmd.subCommands ?? {});
  const subs: Record<string, CommandDef> = {};
  for (const [name, child] of Object.entries(children)) {
    if (!path && aliases[name]) continue;
    subs[name] = await materialize(
      await resolveValue(child),
      [path, name].filter(Boolean).join(" "),
    );
  }
  return {
    ...cmd,
    meta: {
      ...meta,
      name: meta.name ?? path.split(" ").at(-1) ?? "tila",
      description: meta.description ?? path,
    },
    args: await commandArgs(cmd, path),
    ...(Object.keys(subs).length ? { subCommands: subs } : {}),
  };
}

export async function describeCommands(
  cmd: CommandDef,
  path = "",
): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  const meta = await resolveValue(cmd.meta ?? {});
  if (cmd.run || path === "schema") {
    const args = await resolveValue(cmd.args ?? {});
    rows.push({
      name: path,
      aliases:
        path === "task" || path.startsWith("task ")
          ? Object.keys(aliases).map((alias) => path.replace(/^task/, alias))
          : [],
      description: meta.description ?? path,
      mutating: isMutating(path),
      output_kind: isProtocol(path)
        ? "protocol"
        : path === "artifact get" || path === "auth token"
          ? "raw-or-data"
          : "data",
      args: Object.entries(args).map(([name, value]) => ({
        name: value.type === "positional" ? name : `--${name}`,
        ...value,
      })),
      result_description: collectionDefault(path)
        ? "Bounded result.items array; count, effective limit and available continuation in meta"
        : (meta.description ?? path),
      errors: errorDefinitions.map((error) => error.kind),
      stdout_schema: isProtocol(path)
        ? {}
        : {
            type: "object",
            required: ["ok", "result"],
            properties: {
              ok: { const: true },
              result: {},
              meta: { type: "object" },
            },
          },
    });
  }
  for (const [name, child] of Object.entries(
    await resolveValue(cmd.subCommands ?? {}),
  )) {
    rows.push(
      ...(await describeCommands(
        await resolveValue(child),
        [path, name].filter(Boolean).join(" "),
      )),
    );
  }
  return rows;
}

/** Tokenize global flags using the actual command's argument definitions. */
export async function resolveInvocation(root: CommandDef, argv: string[]) {
  let cmd = root;
  const path: string[] = [];
  const rest: string[] = [];
  const globals: Record<string, string | boolean> = {};
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--") {
      rest.push(...argv.slice(i));
      break;
    }
    const args = await commandArgs(cmd, path.join(" "));
    if (token.startsWith("-")) {
      const [name, ...inline] = token.replace(/^--?/, "").split("=");
      // Legacy record patch used --json for its payload. Keep object/array values
      // working while --data is the canonical input and --json selects output.
      if (path.join(" ") === "record patch" && name === "json") {
        const payload = inline.length ? inline.join("=") : argv[i + 1];
        if (payload && /^[\s]*[\[{]/.test(payload)) {
          if (!inline.length) i++;
          rest.push(`--data=${payload}`);
          continue;
        }
      }
      const definition =
        args[name] ??
        Object.values(args).find(
          (arg) =>
            "alias" in arg &&
            (Array.isArray(arg.alias) ? arg.alias : [arg.alias]).includes(name),
        );
      if (!definition && ["help", "h"].includes(name)) {
        help = true;
        continue;
      }
      if (
        !definition &&
        !["version", "v"].includes(name) &&
        !name.startsWith("no-")
      )
        throw Object.assign(new Error(`Unknown option '--${name}'`), {
          code: "invalid-argument",
        });
      const global = name in sharedArgs;
      if (definition?.type === "string" || definition?.type === "enum") {
        const value = inline.length ? inline.join("=") : argv[++i];
        if (value === undefined || (!inline.length && value.startsWith("--")))
          throw Object.assign(new Error(`Missing value for --${name}`), {
            code: "invalid-argument",
          });
        if (global) globals[name] = value;
        else rest.push(`--${name}=${value}`);
      } else if (global) {
        if (inline.length && !["true", "false"].includes(inline[0]))
          throw Object.assign(new Error(`--${name} expects true or false`), {
            code: "invalid-argument",
          });
        globals[name] = inline[0] !== "false";
      } else rest.push(token);
      continue;
    }
    const subs = await resolveValue(cmd.subCommands ?? {});
    if (Object.keys(subs).length) {
      const name = path.length ? token : (aliases[token] ?? token);
      if (!subs[name]) {
        const suggestion = suggest(
          name,
          Object.keys(subs).filter((key) => !aliases[key]),
        );
        throw Object.assign(
          new Error(
            `Unknown command '${token}'.${suggestion ? ` Did you mean '${suggestion}'?` : ""}`,
          ),
          { code: "unknown-command" },
        );
      }
      path.push(name);
      cmd = await resolveValue(subs[name]);
    } else rest.push(token);
  }
  return { cmd, path: path.join(" "), rest, globals, help };
}
export function suggest(input: string, names: string[]): string | undefined {
  const distance = (a: string, b: string) => {
    let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      const row = [i];
      for (let j = 1; j <= b.length; j++)
        row[j] = Math.min(
          row[j - 1] + 1,
          previous[j] + 1,
          previous[j - 1] + Number(a[i - 1] !== b[j - 1]),
        );
      previous = row;
    }
    return previous[b.length];
  };
  return names
    .map((name) => ({ name, distance: distance(input, name) }))
    .filter(
      (x) =>
        x.distance <=
        Math.max(input.length > 2 ? 2 : 1, Math.floor(input.length / 3)),
    )
    .sort((a, b) => a.distance - b.distance || a.name.localeCompare(b.name))[0]
    ?.name;
}
