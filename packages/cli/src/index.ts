import { type CommandDef, defineCommand } from "citty";
import { withErrorBoundary } from "./lib/error-boundary";
import { flushOutput } from "./lib/output";
import { runCli } from "./lib/run-cli";
import { VERSION as version } from "./version";

// Wrap each lazily-loaded command tree so an uncaught backend error (e.g. a
// stale-fence rejection) is rendered as a clean one-line message instead of
// citty dumping the full error object + bundled stack trace.
//
// citty's CommandDef generic is invariant; each command module exports a
// distinct ParsedArgs shape, so the loader result is typed loosely.
// biome-ignore lint/suspicious/noExplicitAny: see note above
type CommandModule = { default: CommandDef<any> };
const load = (loader: () => Promise<CommandModule>): Promise<CommandDef> =>
  loader().then((m) => withErrorBoundary(m.default));

// Pre-dispatch: parse global flags before citty processes argv.
// Citty 0.2.2 has NO arg inheritance, so global context flags must be
// extracted here and stored in the singleton for commands to read via getGlobalFlags().

const main = defineCommand({
  meta: {
    name: "tila",
    version,
    description: "State and coordination engine for multi-machine agentic work",
  },
  args: {
    instance: {
      type: "string" as const,
      description: "Override the active instance key",
    },
    token: {
      type: "string" as const,
      description: "Use an inline bearer token (bypass keychain)",
    },
    project: {
      type: "string" as const,
      description: "Assert or select a project (maps to worker_url)",
    },
    "participant-id": {
      type: "string" as const,
      description: "Use a stable participant ID for this client session",
    },
  },
  subCommands: {
    complete: defineCommand({
      meta: {
        name: "complete",
        description:
          "Generate bash, zsh, fish or powershell completion scripts",
      },
      args: {
        shell: {
          type: "positional",
          required: true,
          description: "bash | zsh | fish | powershell",
        },
      },
      run() {},
    }),
    machine: () => load(() => import("./commands/machine")),
    run: () => load(() => import("./commands/run")),
    lifecycle: () => load(() => import("./commands/lifecycle")),
    task: () => load(() => import("./commands/task")),
    // @deprecated -- both "entity" and "work-unit" are deprecated aliases; use "task"
    entity: () => load(() => import("./commands/entity")),
    // @deprecated -- "work-unit" is deprecated; use "task"
    "work-unit": () => load(() => import("./commands/work-unit")),
    record: () => load(() => import("./commands/record")),
    disconnect: () => load(() => import("./commands/disconnect")),
    init: () => load(() => import("./commands/init")),
    mcp: () => load(() => import("./commands/mcp")),
    open: () => load(() => import("./commands/open")),
    doctor: () => load(() => import("./commands/doctor")),
    update: () => load(() => import("./commands/update")),
    index: () => load(() => import("./commands/index")),
    state: () => load(() => import("./commands/state")),
    presence: () => load(() => import("./commands/presence")),
    signal: () => load(() => import("./commands/signal")),
    artifact: () => load(() => import("./commands/artifact")),
    schema: () => load(() => import("./commands/schema")),
    journal: () => load(() => import("./commands/journal")),
    config: () => load(() => import("./commands/config")),
    deploy: () => load(() => import("./commands/deploy")),
    reset: () => load(() => import("./commands/reset")),
    token: () => load(() => import("./commands/token")),
    "service-account": () => load(() => import("./commands/service-account")),
    repos: () => load(() => import("./commands/repos")),
    admin: () => load(() => import("./commands/admin")),
    auth: () => load(() => import("./commands/auth")),
    switch: () => load(() => import("./commands/switch")),
    instances: () => load(() => import("./commands/instances")),
    shell: () => load(() => import("./commands/shell")),
    link: () => load(() => import("./commands/link")),
    summary: () => load(() => import("./commands/summary")),
    gate: () => load(() => import("./commands/gate")),
    template: () => load(() => import("./commands/template")),
    search: () => load(() => import("./commands/search")),
    infra: () => load(() => import("./commands/infra")),
    project: () => load(() => import("./commands/project")),
  },
});

await runCli(main as unknown as CommandDef, process.argv.slice(2), version);

await flushOutput();
