import { defineCommand } from "citty";
import {
  createConversationMethods,
  createUnsupportedConversationMethods,
} from "tila-sdk";
import { resolveContext } from "../context";
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
export default defineCommand({
  meta: { name: "room", description: "Durable peer conversations" },
  subCommands: {
    create: defineCommand({
      args: {
        ...roomArg,
        name: { type: "string", required: true },
        history: { type: "string", default: "members" },
      },
      async run({ args }) {
        printJson(
          await (await api()).create({
            id: args.room,
            name: args.name,
            history_policy: args.history as "members" | "project",
          }),
        );
      },
    }),
    list: defineCommand({
      args: globalFlagArgs,
      async run() {
        printJson(await (await api()).list());
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
      },
      async run({ args }) {
        printJson(await (await api()).join(args.room, args.member, args.wake));
      },
    }),
    leave: defineCommand({
      args: { ...roomArg, member: { type: "string", required: true } },
      async run({ args }) {
        printJson(await (await api()).leave(args.room, args.member));
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
