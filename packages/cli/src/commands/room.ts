import { defineCommand } from "citty";
import {
  createConversationMethods,
  createUnsupportedConversationMethods,
} from "tila-sdk";
import { resolveContext } from "../context";
import {
  expectedRevision,
  integerFlag,
  revisionArgs,
} from "../lib/expected-revision";
import { globalFlagArgs } from "../lib/global-flags";
import { printJson } from "../lib/output";
async function api() {
  const c = await resolveContext();
  return c.client
    ? createConversationMethods(c.client, c.config.project_id)
    : createUnsupportedConversationMethods();
}
const roomArg = {
  ...globalFlagArgs,
  room: { type: "positional" as const, required: true as const },
};
const settingsArgs = {
  ttl: {
    type: "string" as const,
    description:
      "Delivery TTL in seconds (60-604800); applies to later messages",
  },
  "max-hops": { type: "string" as const, description: "0-8" },
  "pair-exchanges": { type: "string" as const, description: "1-10" },
  "agent-wakes": { type: "string" as const, description: "1-20 per hour" },
  "room-wakes": { type: "string" as const, description: "1-60 per hour" },
};
type SettingsFlags = Partial<Record<keyof typeof settingsArgs, string>>;
const budgetKeys = {
  "max-hops": "max_hops",
  "pair-exchanges": "pair_exchanges",
  "agent-wakes": "agent_wakes",
  "room-wakes": "room_wakes",
} as const;
/** Changed budget fields merged over `current` (budgets replace as a whole). */
function budgets(
  args: SettingsFlags,
  current?: Record<(typeof budgetKeys)[keyof typeof budgetKeys], number>,
) {
  const changed = Object.entries(budgetKeys).flatMap(([flag, key]) => {
    const value = integerFlag(flag, args[flag as keyof typeof budgetKeys]);
    return value === undefined ? [] : [[key, value] as const];
  });
  return changed.length
    ? { ...current, ...Object.fromEntries(changed) }
    : undefined;
}
const memberRevision = {
  "expected-revision": {
    type: "string" as const,
    description: "Room revision you reviewed; omitted applies unconditionally",
  },
};
export default defineCommand({
  meta: { name: "room", description: "Durable peer conversations" },
  subCommands: {
    create: defineCommand({
      args: {
        ...roomArg,
        name: { type: "string", required: true },
        history: { type: "string", default: "members" },
        ...settingsArgs,
      },
      async run({ args }) {
        printJson(
          await (await api()).create({
            id: args.room,
            name: args.name,
            history_policy: args.history as "members" | "project",
            delivery_ttl_seconds: integerFlag("ttl", args.ttl),
            budgets: budgets(args),
          }),
        );
      },
    }),
    update: defineCommand({
      meta: {
        description:
          "Change room settings; TTL and hop/pair budgets apply to later messages, wake budgets at the next dispatch",
      },
      args: {
        ...roomArg,
        ...revisionArgs,
        name: { type: "string" },
        history: {
          type: "string",
          description:
            "members|project; project exposes past history to every reader now",
        },
        ...settingsArgs,
      },
      async run({ args }) {
        const client = await api();
        const needsCurrent =
          args.latest ||
          Object.keys(budgetKeys).some(
            (flag) => args[flag as keyof typeof budgetKeys] !== undefined,
          );
        const current = needsCurrent
          ? (await client.get(args.room)).room
          : undefined;
        const expected = await expectedRevision(args, async () =>
          Number(current?.revision),
        );
        printJson(
          await client.update(args.room, {
            expected_revision: expected,
            name: args.name,
            history_policy: args.history as "members" | "project" | undefined,
            delivery_ttl_seconds: integerFlag("ttl", args.ttl),
            budgets: budgets(args, current?.budgets),
          }),
        );
      },
    }),
    "archive-preview": defineCommand({
      args: roomArg,
      async run({ args }) {
        printJson(await (await api()).archivePreview(args.room));
      },
    }),
    archive: defineCommand({
      meta: {
        description:
          "Stop publication and wakes; history stays readable and pending deliveries expire normally",
      },
      args: { ...roomArg, ...revisionArgs },
      async run({ args }) {
        const client = await api();
        const expected = await expectedRevision(
          args,
          async () => (await client.get(args.room)).room.revision,
        );
        printJson(await client.archive(args.room, expected));
      },
    }),
    unarchive: defineCommand({
      args: { ...roomArg, ...revisionArgs },
      async run({ args }) {
        const client = await api();
        const expected = await expectedRevision(
          args,
          async () => (await client.get(args.room)).room.revision,
        );
        printJson(await client.unarchive(args.room, expected));
      },
    }),
    list: defineCommand({
      args: {
        ...globalFlagArgs,
        "include-archived": { type: "boolean", default: false },
      },
      async run({ args }) {
        printJson(
          await (await api()).list(1, {
            includeArchived: args["include-archived"],
          }),
        );
      },
    }),
    inspect: defineCommand({
      args: roomArg,
      async run({ args }) {
        printJson(await (await api()).get(args.room));
      },
    }),
    join: defineCommand({
      args: {
        ...roomArg,
        member: { type: "string", required: true },
        wake: { type: "boolean", default: true },
        ...memberRevision,
      },
      async run({ args }) {
        printJson(
          await (await api()).join(args.room, args.member, args.wake, {
            expectedRevision: integerFlag(
              "expected-revision",
              args["expected-revision"],
            ),
          }),
        );
      },
    }),
    leave: defineCommand({
      args: {
        ...roomArg,
        member: { type: "string", required: true },
        ...memberRevision,
      },
      async run({ args }) {
        printJson(
          await (await api()).leave(args.room, args.member, {
            expectedRevision: integerFlag(
              "expected-revision",
              args["expected-revision"],
            ),
          }),
        );
      },
    }),
    history: defineCommand({
      args: {
        ...roomArg,
        cursor: { type: "string" },
        limit: { type: "string", default: "50" },
        thread: { type: "string" },
      },
      async run({ args }) {
        printJson(
          await (await api()).history(args.room, {
            cursor: args.cursor,
            limit: Number(args.limit),
            thread_id: args.thread,
          }),
        );
      },
    }),
    publish: defineCommand({
      args: {
        ...roomArg,
        body: { type: "string", required: true },
        "op-id": {
          type: "string",
          required: true,
          description:
            "Stable ID reused on network retry; use reply:<delivery-id> for a reply",
        },
        to: {
          type: "string",
          description:
            "Logical recipient agent; defaults to waking room members",
        },
        thread: { type: "string" },
        "reply-expected": { type: "boolean", default: false },
        "artifact-refs": {
          type: "string",
          description: "JSON array of existing artifact keys",
        },
      },
      async run({ args }) {
        printJson(
          await (await api()).publish(args.room, {
            client_op_id: args["op-id"],
            body: args.body,
            artifact_refs: args["artifact-refs"]
              ? JSON.parse(args["artifact-refs"])
              : [],
            targets: args.to
              ? [{ kind: "agent", agent_id: args.to }]
              : [{ kind: "room" }],
            thread_id: args.thread ?? null,
            reply_expected: args["reply-expected"],
          }),
        );
      },
    }),
  },
});
