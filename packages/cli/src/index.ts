import { defineCommand, runMain } from "citty";
import { VERSION as version } from "./version";

const main = defineCommand({
  meta: {
    name: "tila",
    version,
    description: "State and coordination engine for multi-machine agentic work",
  },
  subCommands: {
    task: () => import("./commands/task").then((m) => m.default),
    // @deprecated -- prefer "work-unit" for new usage
    entity: () => import("./commands/entity").then((m) => m.default),
    "work-unit": () => import("./commands/work-unit").then((m) => m.default),
    record: () => import("./commands/record").then((m) => m.default),
    disconnect: () => import("./commands/disconnect").then((m) => m.default),
    init: () => import("./commands/init").then((m) => m.default),
    mcp: () => import("./commands/mcp").then((m) => m.default),
    open: () => import("./commands/open").then((m) => m.default),
    doctor: () => import("./commands/doctor").then((m) => m.default),
    index: () => import("./commands/index").then((m) => m.default),
    state: () => import("./commands/state").then((m) => m.default),
    presence: () => import("./commands/presence").then((m) => m.default),
    signal: () => import("./commands/signal").then((m) => m.default),
    artifact: () => import("./commands/artifact").then((m) => m.default),
    schema: () => import("./commands/schema").then((m) => m.default),
    journal: () => import("./commands/journal").then((m) => m.default),
    config: () => import("./commands/config").then((m) => m.default),
    deploy: () => import("./commands/deploy").then((m) => m.default),
    reset: () => import("./commands/reset").then((m) => m.default),
    token: () => import("./commands/token").then((m) => m.default),
    summary: () => import("./commands/summary").then((m) => m.default),
    gate: () => import("./commands/gate").then((m) => m.default),
    template: () => import("./commands/template").then((m) => m.default),
    search: () => import("./commands/search").then((m) => m.default),
    infra: () => import("./commands/infra").then((m) => m.default),
    project: () => import("./commands/project").then((m) => m.default),
  },
});

runMain(main);
