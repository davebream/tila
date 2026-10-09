import { ProfileStore, selectedProfile } from "@tila/client-lifecycle";
import {
  AgentRegistrationSchema,
  AttachAgentBindingSchema,
} from "@tila/schemas";
import { defineCommand } from "citty";
import { createAgentMethods, createUnsupportedAgentMethods } from "tila-sdk";
import { resolveContext } from "../context";
import { globalFlagArgs } from "../lib/global-flags";
import { managedRuntime } from "../lib/managed-runtime";
import { printJson } from "../lib/output";

const idArg = {
  ...globalFlagArgs,
  id: { type: "positional" as const, required: true as const },
};
async function api() {
  const ctx = await resolveContext();
  return ctx.client
    ? createAgentMethods(ctx.client, ctx.config.project_id)
    : createUnsupportedAgentMethods();
}
export default defineCommand({
  meta: {
    name: "agent",
    description: "Register and attach durable agent mailboxes",
  },
  subCommands: {
    register: defineCommand({
      args: {
        ...idArg,
        name: { type: "string", required: true },
        "allow-principals": {
          type: "string",
          description:
            "Comma-separated principal IDs permitted to start runs for this agent",
        },
      },
      async run({ args }) {
        printJson(
          await (await api()).register(
            AgentRegistrationSchema.parse({
              id: args.id,
              name: args.name,
              bind_policy: args["allow-principals"]
                ?.split(",")
                .filter(Boolean)
                .map((principal_id) => ({ principal_id, agent_id: args.id })),
            }),
          ),
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
      args: idArg,
      async run({ args }) {
        printJson(await (await api()).get(args.id));
      },
    }),
    bind: defineCommand({
      args: {
        ...idArg,
        "expected-epoch": { type: "string", required: true },
        harness: { type: "string", default: "cli" },
        "native-session": { type: "string" },
      },
      async run({ args }) {
        const client = await api();
        const run = await managedRuntime();
        const selected = selectedProfile();
        const profile = selected
          ? await new ProfileStore().verify(selected.id, selected.revision)
          : null;
        const input = AttachAgentBindingSchema.parse({
          expected_epoch: Number(args["expected-epoch"]),
          harness: args.harness,
          profile,
          native_session_ref: args["native-session"]
            ? {
                host_ref: run?.context.enrollment_id,
                harness: args.harness,
                profile_id: profile?.profile_id,
                session_id: args["native-session"],
              }
            : null,
          capability_report: {
            protocol: 1,
            adapter_version: "1",
            capabilities: {},
          },
          mechanism: "poll",
        });
        printJson(await client.bind(args.id, input));
      },
    }),
    release: defineCommand({
      args: { ...idArg, "expected-epoch": { type: "string", required: true } },
      async run({ args }) {
        printJson(
          await (await api()).release(args.id, Number(args["expected-epoch"])),
        );
      },
    }),
  },
});
