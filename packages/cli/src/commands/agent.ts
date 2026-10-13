import { ProfileStore, selectedProfile } from "@tila/client-lifecycle";
import {
  AgentRegistrationSchema,
  AttachAgentBindingSchema,
} from "@tila/schemas";
import { defineCommand } from "citty";
import { createAgentMethods, createUnsupportedAgentMethods } from "tila-sdk";
import { resolveContext } from "../context";
import {
  expectedRevision,
  integerFlag,
  principalList,
  revisionArgs,
} from "../lib/expected-revision";
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
      args: {
        ...globalFlagArgs,
        "include-archived": {
          type: "boolean",
          default: false,
          description: "Include archived agents (agent managers only)",
        },
      },
      async run({ args }) {
        printJson(
          await (await api()).list({
            includeArchived: args["include-archived"],
          }),
        );
      },
    }),
    inspect: defineCommand({
      args: {
        ...idArg,
        "include-archived": { type: "boolean", default: false },
      },
      async run({ args }) {
        printJson(
          await (await api()).get(args.id, {
            includeArchived: args["include-archived"],
          }),
        );
      },
    }),
    update: defineCommand({
      meta: {
        description:
          "Change the name, binding grants or profile selection; never replaces the active binding",
      },
      args: {
        ...idArg,
        ...revisionArgs,
        name: { type: "string" },
        "allow-principals": {
          type: "string",
          description:
            "Replace binding grants: comma-separated principal IDs (empty clears)",
        },
        profile: {
          type: "string",
          description: "Profile ID new attaches must report",
        },
        "profile-host": {
          type: "string",
          description: "Enrollment ID new attaches must come from",
        },
        "profile-account": {
          type: "string",
          description: "Account reference new attaches must report",
        },
        "clear-profile": { type: "boolean", default: false },
      },
      async run({ args }) {
        if (args["clear-profile"] && args.profile)
          throw new Error("Use either --profile or --clear-profile");
        if ((args["profile-host"] || args["profile-account"]) && !args.profile)
          throw new Error(
            "--profile-host and --profile-account need --profile",
          );
        const client = await api();
        const expected = await expectedRevision(
          args,
          async () => (await client.get(args.id)).agent.revision,
        );
        printJson(
          await client.update(args.id, {
            expected_revision: expected,
            name: args.name,
            bind_policy: principalList(args["allow-principals"])?.map(
              (principal_id) => ({ principal_id, agent_id: args.id }),
            ),
            profile_selection: args["clear-profile"]
              ? null
              : args.profile
                ? {
                    profile_id: args.profile,
                    host_ref: args["profile-host"] ?? null,
                    account_ref: args["profile-account"] ?? null,
                  }
                : undefined,
          }),
        );
      },
    }),
    "archive-preview": defineCommand({
      meta: { description: "Show what archiving would affect now" },
      args: idArg,
      async run({ args }) {
        printJson(await (await api()).archivePreview(args.id));
      },
    }),
    archive: defineCommand({
      meta: {
        description:
          "Archive the agent and release its active binding (the reviewed --expected-epoch)",
      },
      args: {
        ...idArg,
        ...revisionArgs,
        "expected-epoch": {
          type: "string",
          description: "Epoch of the active binding you reviewed",
        },
      },
      async run({ args }) {
        const client = await api();
        let epoch = integerFlag("expected-epoch", args["expected-epoch"]);
        const expected = await expectedRevision(args, async () => {
          const { preview } = await client.archivePreview(args.id);
          epoch ??= preview.binding?.binding_epoch;
          return preview.revision;
        });
        printJson(
          await client.archive(args.id, {
            expected_revision: expected,
            expected_epoch: epoch,
          }),
        );
      },
    }),
    unarchive: defineCommand({
      meta: { description: "Restore the identity; no binding is revived" },
      args: { ...idArg, ...revisionArgs },
      async run({ args }) {
        const client = await api();
        const expected = await expectedRevision(
          args,
          async () =>
            (await client.get(args.id, { includeArchived: true })).agent
              .revision,
        );
        printJson(await client.unarchive(args.id, expected));
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
