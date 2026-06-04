import { defineCommand } from "citty";
import { resolveContext } from "../context";
import { printJson, renderTable, tsToIso } from "../lib/output";

export default defineCommand({
  meta: { name: "journal", description: "Query the project journal" },
  subCommands: {
    tail: defineCommand({
      meta: { name: "tail", description: "Show recent journal events" },
      args: {
        resource: { type: "string", description: "Filter by resource" },
        kind: { type: "string", description: "Filter by event kind" },
        limit: {
          type: "string",
          description: "Number of events",
          default: "20",
        },
        json: {
          type: "boolean",
          description: "Output as JSON",
          default: false,
        },
      },
      async run({ args }) {
        const { journal } = await resolveContext();
        const events = await journal.listJournal({
          resource: args.resource as string | undefined,
          kind: args.kind as string | undefined,
          limit: args.limit ? Number(args.limit) : 20,
        });
        if (args.json) {
          printJson({
            events: events.map((ev) => ({
              ...ev,
              t: tsToIso(ev.t),
            })),
          });
          return;
        }
        if (events.length === 0) {
          console.log("No journal events.");
          return;
        }
        renderTable(
          events.map((ev) => ({
            seq: ev.seq,
            time: new Date(ev.t).toISOString(),
            kind: ev.kind,
            resource: ev.resource,
            actor: ev.actor,
            fence: ev.fence !== null ? ev.fence : "-",
          })),
          [
            { key: "seq", label: "Seq" },
            { key: "time", label: "Time" },
            { key: "kind", label: "Kind" },
            { key: "resource", label: "Resource" },
            { key: "actor", label: "Actor" },
            { key: "fence", label: "Fence" },
          ],
        );
      },
    }),
  },
});
