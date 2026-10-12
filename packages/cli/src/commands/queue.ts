import { readFileSync } from "node:fs";
import { AttemptRequestSchema, QueueRequestSchema } from "@tila/schemas";
import { defineCommand } from "citty";
import { executeAttemptRequest, executeQueueRequest } from "tila-sdk";
import { resolveContext } from "../context";
import {
  failWithCliError,
  jsonArg,
  outputText,
  printJson,
} from "../lib/output";

function operation(family: "queue" | "attempt", action: string) {
  const needsId =
    family === "attempt"
      ? action !== "list"
      : action === "edit" || action === "withdraw";
  const read = ["policy", "inspect", "get", "list"].includes(action);
  return defineCommand({
    meta: {
      name: action,
      description: `${action} ${family} state${read ? "" : " using an idempotency key and current revision where required"}`,
    },
    args: {
      ...jsonArg,
      ...(needsId
        ? {
            id: {
              type: "positional" as const,
              required: true,
              description: `${family === "attempt" ? "Attempt" : "Enrollment"} ID`,
            },
          }
        : {}),
      data: {
        type: "string",
        description: read
          ? "JSON inspection filters"
          : "JSON command (idempotency_key, expected_revision, fence and operation fields)",
      },
      file: {
        type: "string",
        description: "Read command/filter JSON from a file instead of --data",
      },
    },
    async run({ args }) {
      try {
        if (args.data && args.file)
          throw new Error("Use either --data or --file");
        const payload = args.file
          ? JSON.parse(readFileSync(args.file, "utf8"))
          : args.data
            ? JSON.parse(args.data)
            : {};
        const request = {
          action,
          ...(needsId ? { id: args.id } : {}),
          ...(read ? { query: payload } : { command: payload }),
        };
        const ctx = await resolveContext();
        const result =
          family === "queue"
            ? await executeQueueRequest(
                ctx.queue,
                QueueRequestSchema.parse(request),
              )
            : await executeAttemptRequest(
                ctx.attempts,
                AttemptRequestSchema.parse(request),
              );
        if (args.json) printJson({ ok: true, result });
        else outputText(JSON.stringify(result, null, 2));
      } catch (error) {
        failWithCliError(error, !!args.json);
      }
    },
  });
}
export const attemptCommand = defineCommand({
  meta: {
    name: "attempt",
    description: "Inspect and control durable execution attempts",
  },
  subCommands: Object.fromEntries(
    [
      "get",
      "list",
      "accept",
      "started",
      "heartbeat",
      "finish",
      "request-suspension",
      "confirm-suspension",
      "request-resume",
      "claim-resume",
      "request-cancellation",
      "reconcile",
      "rebind",
      "retry",
      "force-recovery",
    ].map((action) => [action, operation("attempt", action)]),
  ),
});
export default defineCommand({
  meta: {
    name: "queue",
    description:
      "Manage explicit enrollment, dispatch policy and execution capacity",
  },
  subCommands: Object.fromEntries(
    [
      "policy",
      "inspect",
      "configure",
      "enroll",
      "edit",
      "withdraw",
      "claim",
    ].map((action) => [action, operation("queue", action)]),
  ),
});
