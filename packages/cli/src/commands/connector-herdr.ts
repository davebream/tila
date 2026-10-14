import {
  ConnectorStore,
  HERDR_CONTRACT,
  HERDR_SUPPORT,
  controlRequest,
  requireHerdrRestoration,
  requireHerdrSupport,
} from "@tila/connector";
import { defineCommand } from "citty";
import { printJson } from "../lib/output";

async function status() {
  let connector: unknown = null;
  try {
    connector = await controlRequest(new ConnectorStore(), {
      action: "status",
    });
  } catch {
    /* No unauthenticated fallback to the running connector. */
  }
  return { contract: HERDR_CONTRACT, support: HERDR_SUPPORT, connector };
}
const selectors = {
  key: {
    type: "string" as const,
    description: "Explicit active lifecycle key",
  },
  socket: {
    type: "string" as const,
    description: "Explicit protected local Herdr socket",
  },
  pane: {
    type: "string" as const,
    description: "Exact pane selector; labels grant no authority",
  },
};
export default defineCommand({
  meta: {
    name: "herdr",
    description:
      "Gated Herdr integration and authenticated connector inspection",
  },
  subCommands: {
    status: defineCommand({
      async run() {
        printJson(await status());
      },
    }),
    reconcile: defineCommand({
      args: selectors,
      async run({ args }) {
        if (!args.key && !args.socket && !args.pane) {
          printJson(
            await controlRequest(new ConnectorStore(), {
              action: "inspect-herdr-registrations",
            }),
          );
          return;
        }
        if (!args.key || !args.socket || !args.pane)
          throw new Error(
            "Provide --key, --socket and --pane together to inspect one session",
          );
        printJson(
          await controlRequest(new ConnectorStore(), {
            action: "inspect-herdr",
            key: args.key,
            target: { kind: "herdr", socket: args.socket, paneId: args.pane },
          }),
        );
      },
    }),
    register: defineCommand({
      args: {
        ...selectors,
        epoch: { type: "string" },
        "allow-idle-start": { type: "boolean", default: false },
      },
      async run({ args }) {
        if (!args.key && !args.socket && !args.pane && !args.epoch)
          requireHerdrSupport();
        if (!args.key || !args.socket || !args.pane || args.epoch === undefined)
          throw new Error(
            "Provide --key, --socket and --pane plus --epoch to select one native session",
          );
        printJson(
          await controlRequest(new ConnectorStore(), {
            action: "register",
            key: args.key,
            expectedEpoch: Number(args.epoch),
            allowIdleStart: args["allow-idle-start"],
            target: { kind: "herdr", socket: args.socket, paneId: args.pane },
          }),
        );
      },
    }),
    open: defineCommand({
      async run() {
        requireHerdrRestoration();
      },
    }),
  },
});
