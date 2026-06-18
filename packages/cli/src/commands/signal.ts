import { defineCommand } from "citty";
import { TILA_ERRORS } from "tila-sdk";
import { resolveContext } from "../context";
import {
  failWithCliError,
  jsonArg,
  printJson,
  printJsonError,
} from "../lib/output";

const sendCommand = defineCommand({
  meta: { name: "send", description: "Send a signal to a target" },
  args: {
    to: {
      type: "string",
      description: "Target token name or '*' for broadcast",
      required: true,
    },
    kind: {
      type: "string",
      description: "Signal kind (conflict, ready, info, request)",
      required: true,
    },
    resource: {
      type: "string",
      description: "Optional resource reference",
    },
    payload: {
      type: "string",
      description: "Optional JSON payload",
    },
    ttl: {
      type: "string",
      description: "TTL in seconds (default: 300)",
    },
    ...jsonArg,
  },
  async run({ args }) {
    const { signal } = await resolveContext();
    const input: {
      target: string;
      kind: string;
      resource?: string;
      payload?: unknown;
      ttl_ms?: number;
    } = {
      target: args.to as string,
      kind: args.kind as string,
    };
    if (args.resource) input.resource = args.resource as string;
    if (args.payload) {
      try {
        input.payload = JSON.parse(args.payload as string);
      } catch {
        // :54 — use real TILA_ERRORS code instead of ad-hoc "INVALID_PAYLOAD"
        printJsonError(
          "Invalid JSON in --payload",
          TILA_ERRORS.VALIDATION_ERROR_DO,
          'Pass valid JSON, e.g. --payload \'{"key":"value"}\'',
          1,
        );
      }
    }
    if (args.ttl) input.ttl_ms = Number(args.ttl) * 1000;

    try {
      const result = await signal.sendSignal(input, "cli");
      if (args.json) {
        printJson({ ok: true, id: result.id });
        return;
      }
      console.log(`Signal sent: ${result.id}`);
    } catch (err) {
      // :73 — use failWithCliError (routes to real TILA_ERRORS code + exitCodeFor)
      if (args.json) {
        failWithCliError(err, true);
      }
      throw err;
    }
  },
});

const inboxCommand = defineCommand({
  meta: { name: "inbox", description: "Show signals for current token" },
  args: {
    ...jsonArg,
  },
  async run({ args }) {
    const { signal } = await resolveContext();
    try {
      const signals = await signal.listSignals("cli");
      if (args.json) {
        printJson({ ok: true, signals });
        return;
      }
      const unacked = signals.filter((s) => s.acked_at === null);
      if (unacked.length === 0) {
        console.log("No unacked signals.");
        return;
      }
      for (const s of unacked) {
        const from = s.created_by;
        const res = s.resource ? `  resource=${s.resource}` : "";
        console.log(`${s.id}  ${s.kind}  from=${from}${res}`);
      }
    } catch (err) {
      // :112 — use failWithCliError for real error code + exit code routing
      if (args.json) {
        failWithCliError(err, true);
      }
      throw err;
    }
  },
});

const ackCommand = defineCommand({
  meta: { name: "ack", description: "Acknowledge a signal" },
  args: {
    id: {
      type: "positional",
      description: "Signal ID",
      required: true,
    },
    ...jsonArg,
  },
  async run({ args }) {
    const { signal } = await resolveContext();
    try {
      // The acker identity must match the inbox identity used in
      // `listSignals("cli")` so the CLI can ack signals addressed to it.
      await signal.ackSignal(args.id as string, "cli");
      if (args.json) {
        printJson({ ok: true });
        return;
      }
      console.log("Signal acked.");
    } catch (err) {
      // :149 — use failWithCliError for real error code + exit code routing
      if (args.json) {
        failWithCliError(err, true);
      }
      throw err;
    }
  },
});

export default defineCommand({
  meta: { name: "signal", description: "Manage inter-agent signals" },
  subCommands: {
    send: sendCommand,
    inbox: inboxCommand,
    ack: ackCommand,
  },
});
