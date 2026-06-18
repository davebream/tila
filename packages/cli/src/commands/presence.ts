import { defineCommand } from "citty";
import { resolveContext } from "../context";
import {
  formatTimestamp,
  jsonArg,
  printJson,
  renderTable,
} from "../lib/output";

// Note: The `active` field is stripped by RemoteBackend.listPresence() because
// the Presence type (from @tila/schemas) lacks the `active` field. The
// [active]/[inactive] prefix is no longer shown (known breaking change RC-3).
async function showPresenceList(json: boolean): Promise<void> {
  const { coordination } = await resolveContext();
  const machines = await coordination.listPresence();
  if (json) {
    // Re-wrap in { ok, machines } envelope for JSON output parity
    printJson({ ok: true, machines });
    return;
  }
  if (machines.length === 0) {
    console.log("No machines.");
    return;
  }
  renderTable(
    machines.map((m) => ({
      machine: m.machine,
      last_seen: formatTimestamp(m.last_seen),
      info: JSON.stringify(m.info),
    })),
    [
      { key: "machine", label: "Machine" },
      { key: "last_seen", label: "Last Seen" },
      { key: "info", label: "Info" },
    ],
  );
}

const listCommand = defineCommand({
  meta: {
    name: "list",
    description: "Show all machines (active and inactive)",
  },
  args: {
    ...jsonArg,
  },
  async run({ args }) {
    await showPresenceList(args.json as boolean);
  },
});

const heartbeatCommand = defineCommand({
  meta: { name: "heartbeat", description: "Send a heartbeat for this machine" },
  args: {
    machine: {
      type: "string",
      description:
        "Machine identity for local mode (server stamps identity in remote mode, default: TILA_MACHINE or os.hostname())",
    },
    ...jsonArg,
  },
  async run({ args }) {
    const { coordination, machine: defaultMachine } = await resolveContext();
    const machine = (args.machine as string | undefined) ?? defaultMachine;
    await coordination.heartbeat(machine, {});
    if (args.json) {
      printJson({ ok: true });
      return;
    }
    console.log(`Heartbeat sent for ${machine}`);
  },
});

export default defineCommand({
  meta: { name: "presence", description: "Manage agent presence" },
  args: {
    ...jsonArg,
  },
  subCommands: {
    list: listCommand,
    heartbeat: heartbeatCommand,
  },
  async run({ args }) {
    // Default: show presence list when no subcommand is given
    await showPresenceList(args.json as boolean);
  },
});
