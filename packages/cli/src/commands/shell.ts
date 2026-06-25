/**
 * `tila shell --instance <key>` — kubie-style per-shell pin (Task 8, WI-L).
 *
 * Spawns $SHELL (fallback /bin/sh) with TILA_INSTANCE=<key> and
 * TILA_SHELL_PINNED=1 injected into the child env. The pin lives only in
 * that subshell's environment — current_context is NEVER written.
 *
 * This is the AC-4 per-shell isolation command. For a process-global
 * switch use `tila switch <key>`.
 *
 * INVARIANT: this command NEVER calls writeCurrentContext or setCurrentContext.
 */

import { spawn } from "node:child_process";
import type { InstanceKey } from "@tila/schemas";
import { defineCommand } from "citty";
import { globalFlagArgs } from "../lib/global-flags";
import { buildAuthStore } from "../lib/instance-context";
import { eprintln, jsonArg } from "../lib/output";

export default defineCommand({
  meta: {
    name: "shell",
    description:
      "Spawn a sub-shell pinned to an instance (per-shell isolation; use `switch` for global)",
  },
  args: {
    // Note: --instance comes from ...globalFlagArgs. It is required at runtime
    // (validated below) since citty 0.2.2 does not support required on spread args.
    ...jsonArg,
    ...globalFlagArgs,
  },
  async run({ args }) {
    const key = args.instance as InstanceKey;
    const authStore = buildAuthStore();

    // Validate the instance exists
    const instance = await authStore.getInstance(key);
    if (!instance) {
      eprintln(
        `Error: Unknown instance "${key}". Run \`tila instances\` to list registered instances.`,
      );
      process.exit(1);
      return;
    }

    // Resolve the shell to spawn
    const shell = process.env.SHELL ?? "/bin/sh";

    // Spawn the child shell with TILA_INSTANCE + TILA_SHELL_PINNED injected.
    // stdio: "inherit" — the child is interactive (stdin/stdout/stderr pass through).
    // NEVER writes current_context — the pin is env-scoped only.
    await new Promise<void>((resolve, reject) => {
      const child = spawn(shell, [], {
        stdio: "inherit",
        env: {
          ...process.env,
          TILA_INSTANCE: key,
          TILA_SHELL_PINNED: "1",
        },
      });

      child.on("error", (err) => {
        eprintln(`Error: Failed to spawn shell: ${err.message}`);
        process.exit(1);
      });

      child.on("close", (code) => {
        const exitCode = code ?? 1;
        if (exitCode !== 0) {
          process.exit(exitCode);
        }
        resolve();
      });
    });
  },
});
