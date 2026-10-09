import { defineCommand } from "citty";
import { createInboxMethods, createUnsupportedInboxMethods } from "tila-sdk";
import { resolveContext } from "../context";
import { globalFlagArgs } from "../lib/global-flags";
import { printJson } from "../lib/output";
async function api() {
  const c = await resolveContext();
  return c.client
    ? createInboxMethods(c.client, c.config.project_id)
    : createUnsupportedInboxMethods();
}
const agentArg = {
  ...globalFlagArgs,
  agent: { type: "positional" as const, required: true as const },
};
const deliveryArg = {
  ...agentArg,
  delivery: { type: "string" as const, required: true as const },
};
export default defineCommand({
  meta: {
    name: "inbox",
    description:
      "Fetch and acknowledge durable deliveries; acknowledgement means accepted processing, never task completion",
  },
  subCommands: {
    fetch: defineCommand({
      args: {
        ...agentArg,
        cursor: { type: "string" },
        limit: { type: "string", default: "50" },
      },
      async run({ args }) {
        printJson(
          await (await api()).fetch(args.agent, {
            cursor: args.cursor,
            limit: Number(args.limit),
          }),
        );
      },
    }),
    ack: defineCommand({
      args: {
        ...deliveryArg,
        binding: { type: "string", required: true },
        epoch: { type: "string", required: true },
        disposition: { type: "string", default: "accepted" },
      },
      async run({ args }) {
        printJson(
          await (await api()).ack(args.agent, args.delivery, {
            consumer_binding_id: args.binding,
            binding_epoch: Number(args.epoch),
            disposition: args.disposition as "accepted" | "declined",
          }),
        );
      },
    }),
    watch: defineCommand({
      args: {
        ...agentArg,
        version: { type: "string" },
        timeout: { type: "string", default: "25000" },
      },
      async run({ args }) {
        printJson(
          await (await api()).watch(args.agent, {
            version: args.version,
            timeout_ms: Number(args.timeout),
          }),
        );
      },
    }),
    explain: defineCommand({
      args: deliveryArg,
      async run({ args }) {
        printJson(await (await api()).explain(args.agent, args.delivery));
      },
    }),
    resume: defineCommand({
      args: deliveryArg,
      async run({ args }) {
        printJson(await (await api()).resume(args.agent, args.delivery));
      },
    }),
  },
});
