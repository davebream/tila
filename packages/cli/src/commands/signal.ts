import type { Signal, SignalTarget } from "@tila/schemas";
import { defineCommand } from "citty";
import { TILA_ERRORS } from "tila-sdk";
import { resolveContext } from "../context";
import {
  boundedItems,
  failWithCliError,
  jsonArg,
  outputText,
  printJson,
  printJsonError,
} from "../lib/output";

function targetFromArgs(args: Record<string, unknown>): SignalTarget {
  const type = args.to;
  const principalId = args["principal-id"] as string | undefined;
  const participantId = args["participant-id"] as string | undefined;
  const groupId = args["group-id"] as string | undefined;
  if (type === "participant" && principalId && participantId) {
    return {
      type: "participant",
      principal_id: principalId,
      participant_id: participantId,
    };
  }
  if (type === "principal" && principalId) {
    return { type: "principal", principal_id: principalId };
  }
  if (type === "group" && groupId) return { type: "group", group_id: groupId };
  if (type === "broadcast") return { type: "broadcast" };
  throw new Error(
    "Invalid target: participant requires --principal-id and --participant-id; principal requires --principal-id; group requires --group-id",
  );
}

function actorLabel(signal: Signal): string {
  const actor = signal.sender;
  const readable =
    actor.display_name ??
    actor.environment.machine ??
    actor.environment.client_name ??
    actor.participant_id;
  return `${readable} (${actor.principal_id}/${actor.participant_id})`;
}

const sendCommand = defineCommand({
  meta: { name: "send", description: "Send a signal to typed recipients" },
  args: {
    to: {
      type: "string",
      description: "Target type: participant, principal, group, or broadcast",
      required: true,
    },
    "principal-id": { type: "string", description: "Target principal ID" },
    "participant-id": { type: "string", description: "Target participant ID" },
    "group-id": { type: "string", description: "Target signal group ID" },
    kind: {
      type: "string",
      description: "conflict, ready, info, or request",
      required: true,
    },
    resource: { type: "string", description: "Optional resource reference" },
    payload: { type: "string", description: "Optional JSON payload" },
    ttl: { type: "string", description: "TTL in seconds (default: 300)" },
    ...jsonArg,
  },
  async run({ args }) {
    return signalHandlers.send(args);
  },
});

const inboxCommand = defineCommand({
  meta: { name: "inbox", description: "Show this participant's signals" },
  args: { ...jsonArg },
  async run({ args }) {
    return signalHandlers.inbox(args);
  },
});

const historyCommand = defineCommand({
  meta: {
    name: "history",
    description: "Show signal delivery history (admin)",
  },
  args: {
    limit: { type: "string", description: "Maximum rows (1-100)" },
    cursor: { type: "string", description: "Pagination cursor" },
    ...jsonArg,
  },
  async run({ args }) {
    return signalHandlers.history(args);
  },
});

const ackCommand = defineCommand({
  meta: { name: "ack", description: "Acknowledge this participant's delivery" },
  args: {
    id: { type: "positional", description: "Signal ID", required: true },
    ...jsonArg,
  },
  async run({ args }) {
    return signalHandlers.ack(args);
  },
});

const groupListCommand = defineCommand({
  meta: { name: "list", description: "List signal groups" },
  args: { ...jsonArg },
  async run({ args }) {
    return signalHandlers.groupList(args);
  },
});

const groupGetCommand = defineCommand({
  meta: { name: "get", description: "Show a signal group" },
  args: {
    id: { type: "positional", description: "Group ID", required: true },
    ...jsonArg,
  },
  async run({ args }) {
    return signalHandlers.groupGet(args);
  },
});

const groupSetCommand = defineCommand({
  meta: {
    name: "set",
    description: "Create or replace a signal group (admin)",
  },
  args: {
    id: { type: "positional", description: "Group ID", required: true },
    name: { type: "string", description: "Display name", required: true },
    principals: {
      type: "string",
      description: "Comma-separated principal IDs",
    },
    ...jsonArg,
  },
  async run({ args }) {
    return signalHandlers.groupSet(args);
  },
});

const groupDeleteCommand = defineCommand({
  meta: { name: "delete", description: "Delete a signal group (admin)" },
  args: {
    id: { type: "positional", description: "Group ID", required: true },
    ...jsonArg,
  },
  async run({ args }) {
    return signalHandlers.groupDelete(args);
  },
});

const groupCommand = defineCommand({
  meta: { name: "group", description: "Manage signal groups" },
  subCommands: {
    list: groupListCommand,
    get: groupGetCommand,
    set: groupSetCommand,
    delete: groupDeleteCommand,
  },
});

export default defineCommand({
  meta: { name: "signal", description: "Manage participant-scoped signals" },
  subCommands: {
    send: sendCommand,
    inbox: inboxCommand,
    history: historyCommand,
    ack: ackCommand,
    group: groupCommand,
  },
});

export type SignalArgs = Record<
  string,
  string | number | boolean | string[] | undefined
>;
export type SignalContext = Pick<
  Awaited<ReturnType<typeof resolveContext>>,
  "signal"
>;
export const signalHandlers = {
  send: async (
    args: SignalArgs,
    context: Promise<SignalContext> | SignalContext = resolveContext(),
  ) => {
    const { signal } = await context;
    try {
      const input = {
        target: targetFromArgs(args),
        kind: args.kind as "conflict" | "ready" | "info" | "request",
        ...(args.resource ? { resource: args.resource as string } : {}),
        ...(args.ttl ? { ttl_ms: Number(args.ttl) * 1000 } : {}),
      } as Parameters<typeof signal.sendSignal>[0];
      if (args.payload) {
        try {
          input.payload = JSON.parse(args.payload as string);
        } catch {
          printJsonError(
            "Invalid JSON in --payload",
            TILA_ERRORS.VALIDATION_ERROR,
            'Pass valid JSON, e.g. --payload \'{"key":"value"}\'',
            1,
          );
        }
      }
      const result = await signal.sendSignal(input);
      if (args.json) return printJson({ ok: true, ...result });
      outputText(
        `Signal sent: ${result.id} (${result.recipient_count} recipient${result.recipient_count === 1 ? "" : "s"})`,
      );
    } catch (err) {
      if (args.json) failWithCliError(err, true);
      throw err;
    }
  },
  inbox: async (
    args: SignalArgs,
    context: Promise<SignalContext> | SignalContext = resolveContext(),
  ) => {
    const { signal } = await context;
    try {
      const signals = await signal.listSignals();
      if (args.json) return printJson({ ok: true, signals });
      if (signals.length === 0) return outputText("No unacknowledged signals.");
      for (const item of boundedItems(signals)) {
        const resource = item.resource ? `  resource=${item.resource}` : "";
        outputText(
          `${item.id}  ${item.kind}  from=${actorLabel(item)}${resource}`,
        );
      }
    } catch (err) {
      if (args.json) failWithCliError(err, true);
      throw err;
    }
  },
  history: async (
    args: SignalArgs,
    context: Promise<SignalContext> | SignalContext = resolveContext(),
  ) => {
    const { signal } = await context;
    const result = await signal.historySignals({
      ...(args.limit ? { limit: Number(args.limit) } : {}),
      ...(args.cursor ? { cursor: args.cursor as string } : {}),
    });
    if (args.json) return printJson({ ok: true, ...result });
    if (result.signals.length === 0) return outputText("No active signals.");
    for (const item of boundedItems(result.signals)) {
      const acknowledged = item.deliveries.filter(
        (delivery) => delivery.acknowledged_at !== null,
      ).length;
      outputText(
        `${item.id}  ${item.kind}  from=${actorLabel(item)}  ack=${acknowledged}/${item.deliveries.length}`,
      );
    }
    if (result.next_cursor) outputText(`Next cursor: ${result.next_cursor}`);
  },
  ack: async (
    args: SignalArgs,
    context: Promise<SignalContext> | SignalContext = resolveContext(),
  ) => {
    const { signal } = await context;
    try {
      await signal.ackSignal(args.id as string);
      if (args.json) return printJson({ ok: true });
      outputText("Signal acknowledged.");
    } catch (err) {
      if (args.json) failWithCliError(err, true);
      throw err;
    }
  },
  groupList: async (
    args: SignalArgs,
    context: Promise<SignalContext> | SignalContext = resolveContext(),
  ) => {
    const { signal } = await context;
    const groups = await signal.listSignalGroups();
    if (args.json) return printJson({ ok: true, groups });
    if (groups.length === 0) return outputText("No signal groups.");
    for (const group of boundedItems(groups)) {
      outputText(
        `${group.id}  ${group.name}  members=${group.principal_ids.length}`,
      );
    }
  },
  groupGet: async (
    args: SignalArgs,
    context: Promise<SignalContext> | SignalContext = resolveContext(),
  ) => {
    const { signal } = await context;
    const group = await signal.getSignalGroup(args.id as string);
    if (!group) throw new Error(`Signal group not found: ${args.id}`);
    if (args.json) return printJson({ ok: true, group });
    outputText(`${group.id}  ${group.name}`);
    for (const principalId of group.principal_ids)
      outputText(`  ${principalId}`);
  },
  groupSet: async (
    args: SignalArgs,
    context: Promise<SignalContext> | SignalContext = resolveContext(),
  ) => {
    const { signal } = await context;
    const group = await signal.setSignalGroup(args.id as string, {
      name: args.name as string,
      principal_ids: String(args.principals ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    });
    if (args.json) return printJson({ ok: true, group });
    outputText(`Signal group saved: ${group.id}`);
  },
  groupDelete: async (
    args: SignalArgs,
    context: Promise<SignalContext> | SignalContext = resolveContext(),
  ) => {
    const { signal } = await context;
    await signal.deleteSignalGroup(args.id as string);
    if (args.json) return printJson({ ok: true });
    outputText("Signal group deleted.");
  },
};
