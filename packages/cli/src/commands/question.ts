import { readFileSync } from "node:fs";
import { QuestionRequestSchema } from "@tila/schemas";
import { defineCommand } from "citty";
import { executeQuestionRequest } from "tila-sdk";
import { resolveContext } from "../context";
import {
  failWithCliError,
  jsonArg,
  outputText,
  printJson,
} from "../lib/output";

export default defineCommand({
  meta: {
    name: "question",
    description:
      "Persist and recover correlated worker questions and decisions",
  },
  subCommands: Object.fromEntries(
    [
      "ask",
      "get",
      "list",
      "answer",
      "escalate",
      "cancel",
      "link-discussion",
    ].map((action) => [
      action,
      defineCommand({
        meta: {
          name: action,
          description: `${action} a durable question; answers do not resume execution`,
        },
        args: {
          ...jsonArg,
          ...(!["ask", "list"].includes(action)
            ? {
                id: {
                  type: "positional" as const,
                  required: true,
                  description: "Question ID",
                },
              }
            : {}),
          data: { type: "string", description: "JSON command or list filters" },
          file: {
            type: "string",
            description: "Read command/filter JSON from a file",
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
            const request = QuestionRequestSchema.parse({
              action,
              id: args.id,
              command: payload,
              query: payload,
            });
            const result = await executeQuestionRequest(
              (await resolveContext()).questions,
              request,
            );
            if (args.json) printJson({ ok: true, result });
            else outputText(JSON.stringify(result, null, 2));
          } catch (error) {
            failWithCliError(error, !!args.json);
          }
        },
      }),
    ]),
  ),
});
