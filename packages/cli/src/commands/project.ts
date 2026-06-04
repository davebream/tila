import { defineCommand } from "citty";

export default defineCommand({
  meta: {
    name: "project",
    description: "Manage tila projects",
  },
  subCommands: {
    create: () => import("./project/create").then((m) => m.default),
    configure: () => import("./project/configure").then((m) => m.default),
    destroy: () => import("./project/destroy").then((m) => m.default),
    list: () => import("./project/list").then((m) => m.default),
  },
});
