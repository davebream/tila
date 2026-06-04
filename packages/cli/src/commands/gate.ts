import { defineCommand } from "citty";
import { resolveContext } from "../context";
import { printJson, tsToIso } from "../lib/output";

export default defineCommand({
  meta: { name: "gate", description: "Manage coordination gates" },
  subCommands: {
    create: defineCommand({
      meta: { name: "create", description: "Create a gate on a resource" },
      args: {
        resource: {
          type: "positional",
          description: "Resource ID to gate",
          required: true,
        },
        "await-type": {
          type: "string",
          description: "Gate type (ci, pr, timer, human, webhook)",
          required: true,
        },
        fence: {
          type: "string",
          description: "Fencing token (number)",
          required: true,
        },
        "timeout-at": {
          type: "string",
          description: "Timeout timestamp (epoch ms, optional)",
        },
        json: {
          type: "boolean",
          description: "Output as JSON",
          default: false,
        },
      },
      async run({ args }) {
        const { gate } = await resolveContext();
        const timeoutAt = args["timeout-at"]
          ? Number(args["timeout-at"])
          : undefined;
        const g = await gate.createGate(
          args.resource as string,
          args["await-type"] as string,
          Number(args.fence),
          timeoutAt,
        );
        if (args.json) {
          printJson({
            ok: true,
            gate: {
              ...g,
              created_at: tsToIso(g.created_at),
              resolved_at: g.resolved_at ? tsToIso(g.resolved_at) : null,
              timeout_at: g.timeout_at ? tsToIso(g.timeout_at) : null,
            },
          });
          return;
        }
        console.log(`Created gate ${g.id} on ${g.resource} (${g.await_type})`);
      },
    }),
    list: defineCommand({
      meta: { name: "list", description: "List gates" },
      args: {
        resource: {
          type: "string",
          description: "Filter by resource ID",
        },
        status: {
          type: "string",
          description:
            "Filter by status (pending, resolved, timed_out, cancelled)",
        },
        json: {
          type: "boolean",
          description: "Output as JSON",
          default: false,
        },
      },
      async run({ args }) {
        const { gate } = await resolveContext();
        const gates = await gate.listGates({
          resource: args.resource as string | undefined,
          status: args.status as string | undefined,
        });
        if (args.json) {
          printJson({
            gates: gates.map((g) => ({
              ...g,
              created_at: tsToIso(g.created_at),
              resolved_at: g.resolved_at ? tsToIso(g.resolved_at) : null,
              timeout_at: g.timeout_at ? tsToIso(g.timeout_at) : null,
            })),
          });
          return;
        }
        if (gates.length === 0) {
          console.log("No gates found.");
          return;
        }
        for (const g of gates) {
          console.log(
            `${g.id}  ${g.resource}  ${g.await_type}  ${g.status}  ${tsToIso(g.created_at)}`,
          );
        }
      },
    }),
    resolve: defineCommand({
      meta: { name: "resolve", description: "Resolve a pending gate" },
      args: {
        gateId: {
          type: "positional",
          description: "Gate ID",
          required: true,
        },
        resolution: {
          type: "string",
          description: "Resolution message (optional)",
        },
        json: {
          type: "boolean",
          description: "Output as JSON",
          default: false,
        },
      },
      async run({ args }) {
        const { gate } = await resolveContext();
        await gate.resolveGate(
          args.gateId as string,
          args.resolution as string | undefined,
        );
        if (args.json) {
          printJson({ ok: true });
          return;
        }
        console.log(`Resolved gate ${args.gateId}`);
      },
    }),
    cancel: defineCommand({
      meta: { name: "cancel", description: "Cancel a pending gate" },
      args: {
        gateId: {
          type: "positional",
          description: "Gate ID",
          required: true,
        },
        json: {
          type: "boolean",
          description: "Output as JSON",
          default: false,
        },
      },
      async run({ args }) {
        const { gate } = await resolveContext();
        await gate.cancelGate(args.gateId as string);
        if (args.json) {
          printJson({ ok: true });
          return;
        }
        console.log(`Cancelled gate ${args.gateId}`);
      },
    }),
  },
});
