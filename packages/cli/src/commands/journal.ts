import { readFileSync } from "node:fs";
import {
  CUSTOM_REPORT_BODY_BYTES,
  JournalAppendRequestSchema,
  journalValidationCode,
} from "@tila/schemas";
import { defineCommand } from "citty";
import { resolveContext } from "../context";
import {
  jsonArg,
  outputText,
  printJson,
  renderTable,
  tsToIso,
} from "../lib/output";

export default defineCommand({
  meta: { name: "journal", description: "Query the project journal" },
  subCommands: {
    append: defineCommand({
      meta: {
        name: "append",
        description:
          "Append an authenticated project report (does not change work state)",
      },
      args: {
        file: {
          type: "string",
          required: true,
          description: "JSON request file, or - for stdin",
        },
        "idempotency-key": {
          type: "string",
          required: true,
          description: "Stable retry key for this report (seven-day window)",
        },
        ...jsonArg,
      },
      async run({ args }) {
        const raw = readFileSync(args.file === "-" ? 0 : args.file, "utf8");
        if (Buffer.byteLength(raw) > CUSTOM_REPORT_BODY_BYTES)
          throw Object.assign(new Error("Report request exceeds 64 KiB"), {
            code: "payload-too-large",
          });
        let body: unknown;
        try {
          body = JSON.parse(raw);
        } catch {
          throw Object.assign(
            new Error("Report file must contain valid JSON"),
            { code: "validation-error" },
          );
        }
        const parsed = JournalAppendRequestSchema.safeParse(body);
        if (!parsed.success)
          throw Object.assign(new Error(parsed.error.message), {
            code: journalValidationCode(parsed.error),
          });
        const input = parsed.data;
        const { journal } = await resolveContext();
        const receipt = await journal.appendJournal(input, {
          idempotencyKey: args["idempotency-key"],
        });
        if (args.json) printJson(receipt);
        else
          outputText(
            `Project report #${receipt.event.seq}: ${receipt.event.data.event_name}`,
          );
      },
    }),
    tail: defineCommand({
      meta: { name: "tail", description: "Show recent journal events" },
      args: {
        resource: { type: "string", description: "Filter by resource" },
        kind: { type: "string", description: "Filter by event kind" },
        "event-name": {
          type: "string",
          description: "Filter by custom event name",
        },
        "correlation-id": {
          type: "string",
          description: "Filter by report correlation ID",
        },
        "client-name": {
          type: "string",
          description: "Filter by environment client name",
        },
        limit: {
          type: "string",
          description: "Number of events",
          default: "20",
        },
        ...jsonArg,
      },
      async run({ args }) {
        const { journal } = await resolveContext();
        const events = await journal.listJournal({
          resource: args.resource as string | undefined,
          kind: args.kind as string | undefined,
          event_name: args["event-name"] as string | undefined,
          correlation_id: args["correlation-id"] as string | undefined,
          client_name: args["client-name"] as string | undefined,
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
          outputText("No journal events.");
          return;
        }
        renderTable(
          events.map((ev) => ({
            seq: ev.seq,
            time: new Date(ev.t).toISOString(),
            kind:
              ev.kind === "custom.reported"
                ? `Project report: ${ev.data.event_name}`
                : ev.kind,
            resource: ev.resource,
            principal: ev.principal_id,
            participant: ev.participant_id,
            fence: ev.fence !== null ? ev.fence : "-",
          })),
          [
            { key: "seq", label: "Seq" },
            { key: "time", label: "Time" },
            { key: "kind", label: "Kind" },
            { key: "resource", label: "Resource" },
            { key: "principal", label: "Principal" },
            { key: "participant", label: "Participant" },
            { key: "fence", label: "Fence" },
          ],
        );
      },
    }),
  },
});
