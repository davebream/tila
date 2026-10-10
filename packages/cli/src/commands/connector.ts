import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { profileEnvironment } from "@tila/client-lifecycle";
import {
  ConnectorControl,
  ConnectorStore,
  HostConnector,
  StandaloneDiscovery,
  controlRequest,
} from "@tila/connector";
import { defineCommand } from "citty";
import { openConnectorSession } from "../lib/connector-launch";
import { relayFactory } from "../lib/connector-runtime";
import { globalFlagArgs } from "../lib/global-flags";
import { cliInvocation } from "../lib/lifecycle-runtime";
import { printJson } from "../lib/output";

async function serve(): Promise<void> {
  const store = new ConnectorStore();
  const connector = new HostConnector(
    store,
    new StandaloneDiscovery(),
    relayFactory,
  );
  const control = new ConnectorControl(store);
  const stop = () => {
    void connector.request({ action: "stop" });
  };
  await control.listen((request) => connector.request(request));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    while (!connector.stopped) {
      await connector.tick();
      if (!connector.stopped) await delay(5000);
    }
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    await connector.close();
    await control.close();
  }
}
const key = {
  key: {
    type: "positional" as const,
    required: true as const,
    description: "Discovered lifecycle session key from tila lifecycle status",
  },
};
export default defineCommand({
  meta: {
    name: "connector",
    description: "Host-local native wake delivery for enrolled sessions",
  },
  subCommands: {
    open: defineCommand({
      args: {
        ...globalFlagArgs,
        agent: { type: "string", required: true },
        profile: { type: "string", required: true },
        session: { type: "string", required: true },
        operation: {
          type: "string",
          required: true,
          description:
            "Stable launch operation UUID; uncertain operations are never repeated",
        },
      },
      async run({ args }) {
        printJson(await openConnectorSession(args));
      },
    }),
    start: defineCommand({
      args: { foreground: { type: "boolean", default: false } },
      async run({ args }) {
        if (args.foreground) return serve();
        const store = new ConnectorStore();
        try {
          printJson(await controlRequest(store, { action: "status" }));
          return;
        } catch {
          /* Startup lock rejects another live connector. */
        }
        const [command, ...invocation] = cliInvocation();
        const env = profileEnvironment();
        env.TILA_HOME = process.env.TILA_HOME;
        const child = spawn(
          command,
          [...invocation, "connector", "start", "--foreground"],
          { detached: true, stdio: "ignore", env },
        );
        await new Promise<void>((resolve, reject) => {
          child.once("spawn", resolve);
          child.once("error", reject);
        });
        child.unref();
        for (let attempt = 0; attempt < 50; attempt++) {
          await delay(100);
          try {
            printJson(await controlRequest(store, { action: "status" }));
            return;
          } catch {
            /* Wait only for this bounded startup. */
          }
        }
        throw new Error(
          "Connector startup unavailable; run tila connector start --foreground for diagnostics",
        );
      },
    }),
    status: defineCommand({
      async run() {
        printJson(
          await controlRequest(new ConnectorStore(), { action: "status" }),
        );
      },
    }),
    stop: defineCommand({
      async run() {
        printJson(
          await controlRequest(new ConnectorStore(), { action: "stop" }),
        );
      },
    }),
    register: defineCommand({
      args: {
        ...key,
        epoch: {
          type: "string",
          required: true,
          description:
            "Expected current agent binding epoch (0 for first attachment)",
        },
        "allow-idle-start": { type: "boolean", default: false },
      },
      async run({ args }) {
        printJson(
          await controlRequest(new ConnectorStore(), {
            action: "register",
            key: args.key,
            expectedEpoch: Number(args.epoch),
            allowIdleStart: args["allow-idle-start"],
          }),
        );
      },
    }),
    unregister: defineCommand({
      args: key,
      async run({ args }) {
        printJson(
          await controlRequest(new ConnectorStore(), {
            action: "unregister",
            key: args.key,
          }),
        );
      },
    }),
  },
});
