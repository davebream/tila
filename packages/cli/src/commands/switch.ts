/**
 * `tila switch <key>` — sole writer of current_context (Task 6, WI-L).
 *
 * SINGLE-WRITER INVARIANT: this command is the ONLY authorized caller of
 * writeCurrentContext(store, key). No other command may call setCurrentContext
 * directly — enforced by a grep guard test in instance-context.test.ts.
 *
 * Validates the key via getInstance() then delegates the write to
 * writeCurrentContext() from lib/instance-context.
 *
 * Documented as process-global (affects every terminal). Use
 * `tila shell --instance <key>` for per-shell isolation.
 */

import type { InstanceKey } from "@tila/schemas";
import { defineCommand } from "citty";
import { globalFlagArgs } from "../lib/global-flags";
import { buildAuthStore, writeCurrentContext } from "../lib/instance-context";
import {
  eprintln,
  jsonArg,
  printJsonError,
  printJsonSuccess,
} from "../lib/output";

export default defineCommand({
  meta: {
    name: "switch",
    description:
      "Switch the active tila instance (process-global; use `shell` for per-shell pin)",
  },
  args: {
    key: {
      type: "positional" as const,
      description: "Instance key to switch to",
      required: true,
    },
    ...jsonArg,
    ...globalFlagArgs,
  },
  async run({ args }) {
    const key = args.key as InstanceKey;
    const authStore = buildAuthStore();

    // Validate the key exists in the registry
    const instance = await authStore.getInstance(key);
    if (!instance) {
      const msg = `Unknown instance "${key}". Run \`tila instances\` to list registered instances or \`tila link <url>\` to register one.`;
      if (args.json) {
        printJsonError(msg, "instance-not-found", undefined, 1);
      } else {
        eprintln(`Error: ${msg}`);
        process.exit(1);
      }
      return;
    }

    // Write — the ONLY authorized call-site for current_context mutation
    await writeCurrentContext(authStore, key);

    if (args.json) {
      printJsonSuccess({ instance_key: key, worker_url: instance.worker_url });
    } else {
      console.log(`Switched to instance "${key}" (${instance.worker_url})`);
    }
  },
});
