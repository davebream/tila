/**
 * `tila instances` command group — WRITE/MGMT PATH (Task 7b, WI-L).
 *
 * Subcommands:
 *   instances list           — registry view (AC-8, AC-5)
 *   instances remove <key>   — remove instance + best-effort keychain cleanup
 *   instances forget <key>   — alias for remove
 *
 * Removal ordering (crash-safe):
 *   1. deleteCredential (best-effort — never throws on keychain error)
 *   2. deleteRefresh    (best-effort)
 *   3. deleteInstance   (registry removal + pin clear)
 *
 * This ordering ensures a crash between steps leaves an orphaned (harmless)
 * keychain entry rather than a dangling registry pointer.
 *
 * SINGLE-WRITER INVARIANT: no direct call to setCurrentContext.
 * Pin clearing is delegated to AuthStore.deleteInstance().
 */

import type { InstanceKey } from "@tila/schemas";
import { defineCommand } from "citty";
import { globalFlagArgs } from "../lib/global-flags";
import { buildAuthStore } from "../lib/instance-context";
import {
  eprintln,
  formatExpiry,
  formatTrust,
  jsonArg,
  printJsonError,
  printJsonSuccess,
  renderTable,
} from "../lib/output";

// ---------------------------------------------------------------------------
// instances list
// ---------------------------------------------------------------------------

const listCmd = defineCommand({
  meta: {
    name: "list",
    description: "List all registered tila instances",
  },
  args: {
    ...jsonArg,
    ...globalFlagArgs,
  },
  async run({ args }) {
    const authStore = buildAuthStore();
    const instances = await authStore.listInstances();
    const currentContext = await authStore.getCurrentContext();

    if (args.json) {
      // Build safe per-instance metadata (no tokens)
      const instancesJson = instances.map((inst) => ({
        instance_key: inst.instance_key,
        label: inst.label ?? null,
        worker_url: inst.worker_url,
        trust: inst.trust,
        is_current: inst.instance_key === currentContext,
      }));

      printJsonSuccess({
        current_context: currentContext,
        instances: instancesJson,
      });
      return;
    }

    if (instances.length === 0) {
      console.log(
        "No instances registered. Run `tila link <worker_url>` to register one.",
      );
      return;
    }

    const rows = instances.map((inst) => ({
      key: `${inst.instance_key}${inst.instance_key === currentContext ? " ◀" : ""}`,
      label: inst.label ?? "—",
      worker_url: inst.worker_url,
      trust: formatTrust(
        inst.trust.trusted
          ? { kind: "trusted" as const }
          : {
              kind: "untrusted-needs-login" as const,
              reason: "not-trusted" as const,
            },
      ),
    }));

    renderTable(rows, [
      { key: "key", label: "Key" },
      { key: "label", label: "Label" },
      { key: "worker_url", label: "Worker URL" },
      { key: "trust", label: "Trust" },
    ]);
  },
});

// ---------------------------------------------------------------------------
// instances remove / forget
// ---------------------------------------------------------------------------

const removeCmd = defineCommand({
  meta: {
    name: "remove",
    description:
      "Remove a registered instance (removes registry entry and keychain secrets)",
  },
  args: {
    key: {
      type: "positional" as const,
      description: "Instance key to remove",
      required: true,
    },
    yes: {
      type: "boolean" as const,
      description: "Skip confirmation prompt",
      default: false,
    },
    ...jsonArg,
    ...globalFlagArgs,
  },
  async run({ args }) {
    const key = args.key as InstanceKey;
    const authStore = buildAuthStore();

    // Validate the key exists before doing anything
    const instance = await authStore.getInstance(key);
    if (!instance) {
      const msg = `Unknown instance "${key}". Run \`tila instances list\` to see registered instances.`;
      if (args.json) {
        printJsonError(msg, "instance-not-found", undefined, 1);
      } else {
        eprintln(`Error: ${msg}`);
        process.exit(1);
      }
      return;
    }

    // Step 1: Best-effort keychain cleanup FIRST (write-ordering: crash leaves
    // an orphaned keychain entry rather than a dangling registry pointer)
    try {
      await authStore.deleteCredential(key);
    } catch {
      // best-effort — ignore keychain errors (e.g. KeychainUnavailableError)
    }
    try {
      await authStore.deleteRefresh(key);
    } catch {
      // best-effort
    }

    // Step 2: Remove registry record + clear dangling pin if needed
    await authStore.deleteInstance(key);

    if (args.json) {
      printJsonSuccess({ removed: key });
    } else {
      console.log(`Removed instance "${key}".`);
    }
  },
});

// forgetCmd is an alias for removeCmd with a different meta name
const forgetCmd = defineCommand({
  meta: {
    name: "forget",
    description: "Alias for `instances remove` — remove a registered instance",
  },
  args: {
    key: {
      type: "positional" as const,
      description: "Instance key to remove",
      required: true,
    },
    yes: {
      type: "boolean" as const,
      description: "Skip confirmation prompt",
      default: false,
    },
    ...jsonArg,
    ...globalFlagArgs,
  },
  async run({ args }) {
    // Delegate to removeCmd's run handler with same args
    const key = args.key as InstanceKey;
    const authStore = buildAuthStore();

    const instance = await authStore.getInstance(key);
    if (!instance) {
      const msg = `Unknown instance "${key}". Run \`tila instances list\` to see registered instances.`;
      if (args.json) {
        printJsonError(msg, "instance-not-found", undefined, 1);
      } else {
        eprintln(`Error: ${msg}`);
        process.exit(1);
      }
      return;
    }

    try {
      await authStore.deleteCredential(key);
    } catch {
      // best-effort
    }
    try {
      await authStore.deleteRefresh(key);
    } catch {
      // best-effort
    }

    await authStore.deleteInstance(key);

    if (args.json) {
      printJsonSuccess({ removed: key });
    } else {
      console.log(`Removed instance "${key}".`);
    }
  },
});

// ---------------------------------------------------------------------------
// instances command group
// ---------------------------------------------------------------------------

export default defineCommand({
  meta: {
    name: "instances",
    description: "Manage registered tila instances",
  },
  subCommands: {
    list: listCmd,
    remove: removeCmd,
    forget: forgetCmd,
  },
});
