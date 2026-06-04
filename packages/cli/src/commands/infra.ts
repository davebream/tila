import { defineCommand } from "citty";

export default defineCommand({
  meta: {
    name: "infra",
    description: "Manage account-level tila infrastructure",
  },
  subCommands: {
    provision: () => import("./infra/provision").then((m) => m.default),
    teardown: () => import("./infra/teardown").then((m) => m.default),
    status: () => import("./infra/status").then((m) => m.default),
  },
});
