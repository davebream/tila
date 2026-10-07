import { SessionStore } from "@tila/client-lifecycle";
import { LifecycleClientSchema } from "@tila/schemas";
import { defineCommand } from "citty";
import { configureLifecycle } from "../lib/lifecycle-install";
import {
  ensureWorker,
  lifecycleNamespace,
  runLifecycleHook,
  runLifecycleWorker,
} from "../lib/lifecycle-runtime";
import {
  currentOutput,
  diagnostic,
  jsonArg,
  outputText,
  printJson,
  protocolJson,
} from "../lib/output";

export default defineCommand({
  meta: {
    name: "lifecycle",
    description: "Configure and inspect coding-session lifecycle integration",
  },
  subCommands: {
    install: defineCommand({
      args: {
        client: { type: "positional", required: true },
        "dry-run": { type: "boolean", default: false },
      },
      async run({ args }) {
        configureLifecycle(
          LifecycleClientSchema.parse(args.client),
          "install",
          args["dry-run"],
        );
      },
    }),
    remove: defineCommand({
      args: {
        client: { type: "positional", required: true },
        "dry-run": { type: "boolean", default: false },
      },
      async run({ args }) {
        configureLifecycle(
          LifecycleClientSchema.parse(args.client),
          "remove",
          args["dry-run"],
        );
      },
    }),
    status: defineCommand({
      async run() {
        const namespace = lifecycleNamespace();
        printJson(
          new SessionStore()
            .list()
            .filter((state) => state.namespace === namespace),
        );
      },
    }),
    retry: defineCommand({
      async run() {
        const namespace = lifecycleNamespace();
        const store = new SessionStore();
        for (const state of store.list())
          if (state.namespace === namespace && state.phase === "closing")
            await ensureWorker(store, state);
      },
    }),
    hook: defineCommand({
      args: { client: { type: "string", required: true } },
      async run({ args }) {
        try {
          let input = "";
          for await (const chunk of process.stdin) {
            input += chunk;
            if (input.length > 1024 * 1024)
              throw new Error("Hook input exceeds 1 MiB");
          }
          await runLifecycleHook(
            LifecycleClientSchema.parse(args.client),
            JSON.parse(input),
          );
        } catch {
          // Hooks are advisory. Do not expose credential errors or block local work.
          const message =
            "Tila lifecycle degraded. Run tila lifecycle status; local work can continue.";
          diagnostic(message);
          protocolJson({ systemMessage: message });
        }
      },
    }),
    worker: defineCommand({
      args: {
        key: { type: "positional", required: true },
        generation: { type: "positional", required: true },
      },
      async run({ args }) {
        try {
          await runLifecycleWorker(args.key, args.generation);
        } catch {
          // Detached workers have no presentation channel, including startup failures.
          process.exitCode = 1;
        }
      },
    }),
  },
});
