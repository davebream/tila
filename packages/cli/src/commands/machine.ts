import { defineCommand } from "citty";
import { credentialPolicyArgs, policyFromArgs } from "../lib/credential-policy";
import { globalFlagArgs } from "../lib/global-flags";
import { printJson } from "../lib/output";
import {
  enrollMachine,
  runtimeOperatorClient,
  runtimeSelection,
} from "../lib/runtime";

const policyArgs = {
  ...credentialPolicyArgs,
  preset: { ...credentialPolicyArgs.preset, default: "worker" },
};
const idArg = {
  id: {
    type: "positional" as const,
    required: true as const,
    description: "Enrollment ID",
  },
};
export default defineCommand({
  meta: {
    name: "machine",
    description: "Authorize and manage project installations",
  },
  subCommands: {
    enroll: defineCommand({
      args: {
        ...globalFlagArgs,
        ...policyArgs,
        name: { type: "string" },
        "file-store": {
          type: "string",
          description:
            "Explicit protected file-store directory for headless runners",
        },
        "invitation-stdin": { type: "boolean", default: false },
      },
      async run({ args }) {
        let invitation: string | undefined;
        if (args["invitation-stdin"]) {
          const chunks: Buffer[] = [];
          let size = 0;
          for await (const chunk of process.stdin) {
            size += chunk.length;
            if (size > 512)
              throw new Error("Invitation exceeds maximum length");
            chunks.push(Buffer.from(chunk));
          }
          invitation = Buffer.concat(chunks).toString().trim();
          if (!invitation) throw new Error("Invitation input is required");
        }
        const reference = await enrollMachine({
          name: args.name,
          fileStore: args["file-store"],
          invitation,
          policy: policyFromArgs(args),
        });
        printJson({ ok: true, ...reference });
      },
    }),
    authorize: defineCommand({
      args: {
        ...globalFlagArgs,
        ...policyArgs,
        name: { type: "string", required: true },
      },
      async run({ args }) {
        const api = await runtimeOperatorClient(await runtimeSelection());
        // This explicit credential-delivery command is the only setup command that
        // prints a secret. Personal enrollment never prints its authenticator.
        printJson(await api.authorize(args.name, policyFromArgs(args)));
      },
    }),
    list: defineCommand({
      args: { ...globalFlagArgs },
      async run() {
        printJson(
          await (
            await runtimeOperatorClient(await runtimeSelection())
          ).enrollments(),
        );
      },
    }),
    inspect: defineCommand({
      args: { ...globalFlagArgs, ...idArg },
      async run({ args }) {
        const rows = await (
          await runtimeOperatorClient(await runtimeSelection())
        ).enrollments();
        const enrollment = rows.enrollments.find(
          (row) => row.enrollment_id === args.id,
        );
        if (!enrollment) throw new Error("Installation is not accessible");
        printJson({ ok: true, enrollment });
      },
    }),
    revoke: defineCommand({
      args: { ...globalFlagArgs, ...idArg },
      async run({ args }) {
        printJson(
          await (
            await runtimeOperatorClient(await runtimeSelection())
          ).revokeEnrollment(args.id),
        );
      },
    }),
  },
});
