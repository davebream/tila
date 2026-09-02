import { defineCommand } from "citty";
import { resolveContext } from "../context";
import {
  formatTimestamp,
  jsonArg,
  printJson,
  renderTable,
} from "../lib/output";

async function showPresenceList(json: boolean): Promise<void> {
  const { coordination } = await resolveContext();
  const participants = await coordination.listPresence();
  if (json) {
    printJson({ ok: true, participants });
    return;
  }
  if (participants.length === 0) {
    console.log("No participants.");
    return;
  }
  renderTable(
    participants.map((participant) => ({
      principal_id: participant.principal_id,
      participant_id: participant.participant_id,
      machine: participant.environment.machine ?? "",
      last_seen: formatTimestamp(participant.last_seen),
      info: JSON.stringify(participant.info),
    })),
    [
      { key: "principal_id", label: "Principal" },
      { key: "participant_id", label: "Participant" },
      { key: "machine", label: "Machine" },
      { key: "last_seen", label: "Last Seen" },
      { key: "info", label: "Info" },
    ],
  );
}

const listCommand = defineCommand({
  meta: {
    name: "list",
    description: "Show all participants",
  },
  args: {
    ...jsonArg,
  },
  async run({ args }) {
    await showPresenceList(args.json as boolean);
  },
});

const heartbeatCommand = defineCommand({
  meta: { name: "heartbeat", description: "Send a participant heartbeat" },
  args: {
    ...jsonArg,
  },
  async run({ args }) {
    const { coordination, participantId } = await resolveContext();
    await coordination.heartbeat({});
    if (args.json) {
      printJson({ ok: true });
      return;
    }
    console.log(`Heartbeat sent for participant ${participantId}`);
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
