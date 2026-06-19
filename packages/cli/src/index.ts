import { type CommandDef, defineCommand, runMain } from "citty";
import { withErrorBoundary } from "./lib/error-boundary";
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

const main = defineCommand({
  meta: {
    name: "tila",
    version,
    description: "State and coordination engine for multi-machine agentic work",
  },
  subCommands: {
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
    summary: () => load(() => import("./commands/summary")),
    gate: () => load(() => import("./commands/gate")),
    template: () => load(() => import("./commands/template")),
    search: () => load(() => import("./commands/search")),
    infra: () => load(() => import("./commands/infra")),
    project: () => load(() => import("./commands/project")),
  },
});

runMain(main);
