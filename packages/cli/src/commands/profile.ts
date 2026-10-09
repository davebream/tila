import { ProfileStore } from "@tila/client-lifecycle";
import { CredentialProfileSchema } from "@tila/schemas";
import { defineCommand } from "citty";
import { printJson } from "../lib/output";

const idArg = { id: { type: "positional" as const, required: true as const } };
export default defineCommand({
  meta: {
    name: "profile",
    description: "Manage host-local provider account profiles",
  },
  subCommands: {
    add: defineCommand({
      args: {
        ...idArg,
        harness: { type: "string", required: true },
        launcher: { type: "string", required: true },
        "config-dir": { type: "string", required: true },
        account: {
          type: "string",
          required: true,
          description:
            "Expected provider account email (stored as a host-keyed reference)",
        },
        "credential-store": { type: "string", default: "auto" },
        endpoint: { type: "string" },
        "env-allowlist": {
          type: "string",
          description: "Comma-separated additional environment variable names",
        },
      },
      run({ args }) {
        const settings = CredentialProfileSchema.omit({
          revision: true,
          account_ref: true,
        }).parse({
          id: args.id,
          harness: args.harness,
          launcher: args.launcher,
          config_dir: args["config-dir"],
          credential_store: args["credential-store"],
          endpoint: args.endpoint,
          env_allowlist: args["env-allowlist"]?.split(",").filter(Boolean),
        });
        printJson({
          ok: true,
          profile: new ProfileStore().add({
            ...settings,
            account: args.account,
          }),
        });
      },
    }),
    list: defineCommand({
      run() {
        printJson({ ok: true, profiles: new ProfileStore().list() });
      },
    }),
    verify: defineCommand({
      args: idArg,
      async run({ args }) {
        printJson({
          ok: true,
          evidence: await new ProfileStore().verify(args.id),
        });
      },
    }),
    remove: defineCommand({
      args: idArg,
      run({ args }) {
        new ProfileStore().remove(args.id);
        printJson({ ok: true });
      },
    }),
  },
});
