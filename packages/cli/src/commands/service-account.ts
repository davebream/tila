import {
  ServiceAccountCreateRequestSchema,
  ServiceAccountUpdateRequestSchema,
  WorkloadBindingRequestSchema,
  WorkloadBindingUpdateRequestSchema,
} from "@tila/schemas";
import { defineCommand } from "citty";
import { createServiceAccountMethods } from "tila-sdk";
import { requireClient, resolveContext } from "../context";
import { credentialPolicyArgs, policyFromArgs } from "../lib/credential-policy";
import { jsonArg, printJson } from "../lib/output";

async function client() {
  const ctx = await resolveContext();
  return createServiceAccountMethods(requireClient(ctx), ctx.config.project_id);
}
const revisionArg = {
  "expected-revision": {
    type: "string" as const,
    description: "Revision reviewed before this edit",
  },
};
const revisionFromArgs = (value: string | undefined) =>
  value === undefined ? undefined : Number(value);
const principalArg = {
  principal: {
    type: "positional" as const,
    required: true as const,
    description: "Service principal ID",
  },
};
export default defineCommand({
  meta: {
    name: "service-account",
    description: "Manage project service identities and workload bindings",
  },
  subCommands: {
    list: defineCommand({
      args: { ...jsonArg },
      async run() {
        printJson(await (await client()).list());
      },
    }),
    create: defineCommand({
      args: {
        name: { type: "string", required: true },
        "display-name": { type: "string", required: true },
        role: { type: "string", default: "viewer" },
        ...jsonArg,
      },
      async run({ args }) {
        printJson(
          await (await client()).create(
            ServiceAccountCreateRequestSchema.parse({
              name: args.name,
              display_name: args["display-name"],
              role: args.role,
            }),
          ),
        );
      },
    }),
    update: defineCommand({
      args: {
        ...principalArg,
        "display-name": { type: "string", required: true },
        ...revisionArg,
        ...jsonArg,
      },
      async run({ args }) {
        const input = ServiceAccountUpdateRequestSchema.parse({
          display_name: args["display-name"],
          expected_revision: revisionFromArgs(args["expected-revision"]),
        });
        printJson(
          await (await client()).update(
            args.principal,
            input.display_name,
            input.expected_revision,
          ),
        );
      },
    }),
    revoke: defineCommand({
      args: { ...principalArg, ...jsonArg },
      async run({ args }) {
        printJson(await (await client()).revoke(args.principal));
      },
    }),
    workload: defineCommand({
      subCommands: {
        list: defineCommand({
          args: { ...principalArg, ...jsonArg },
          async run({ args }) {
            printJson(
              await (await client()).listWorkloadBindings(args.principal),
            );
          },
        }),
        create: defineCommand({
          args: {
            ...principalArg,
            ...credentialPolicyArgs,
            name: { type: "string", required: true },
            provider: { type: "string", required: true },
            issuer: { type: "string", required: true },
            subject: { type: "string", required: true },
            ...jsonArg,
          },
          async run({ args }) {
            printJson(
              await (await client()).createWorkloadBinding(
                args.principal,
                WorkloadBindingRequestSchema.parse({
                  name: args.name,
                  provider: args.provider,
                  issuer: args.issuer,
                  subject: args.subject,
                  policy: policyFromArgs(args),
                }),
              ),
            );
          },
        }),
        update: defineCommand({
          args: {
            ...principalArg,
            ...credentialPolicyArgs,
            ...revisionArg,
            binding: { type: "string", required: true },
            ...jsonArg,
          },
          async run({ args }) {
            const input = WorkloadBindingUpdateRequestSchema.parse({
              policy: policyFromArgs(args),
              expected_revision: revisionFromArgs(args["expected-revision"]),
            });
            printJson(
              await (await client()).updateWorkloadBinding(
                args.principal,
                args.binding,
                input.policy,
                input.expected_revision,
              ),
            );
          },
        }),
        revoke: defineCommand({
          args: {
            ...principalArg,
            binding: { type: "string", required: true },
            ...jsonArg,
          },
          async run({ args }) {
            printJson(
              await (await client()).revokeWorkloadBinding(
                args.principal,
                args.binding,
              ),
            );
          },
        }),
      },
    }),
  },
});
