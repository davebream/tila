import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  AttemptRequestSchema,
  AttemptResultSchema,
  QueueRequestSchema,
  QueueResultSchema,
} from "@tila/schemas";
import {
  type TilaFacade,
  executeAttemptRequest,
  executeQueueRequest,
} from "tila-sdk";
import { registerResultTool } from "../tool-registration";

export function registerQueueTools(
  server: McpServer,
  facade: TilaFacade,
  _projectId: string,
): void {
  registerResultTool(
    server,
    "tila_queue",
    "Inspect or explicitly enroll managed work, edit priority/target, configure capacity/pause, withdraw or claim. Claim reserves capacity only: accept the attempt before launching. Scheduling capabilities never grant permission. Use stable idempotency keys and current revisions; a replay with grant_valid=false does not authorize execution.",
    { request: QueueRequestSchema },
    QueueResultSchema,
    async ({ request }) => {
      const result = await executeQueueRequest(facade.queue, request);
      return {
        content: [{ type: "text", text: JSON.stringify({ result }) }],
        structuredContent: { result },
      };
    },
  );
  registerResultTool(
    server,
    "tila_attempt",
    "Inspect attempts; accept, bind a started session, heartbeat, finish, request/confirm suspension, request/claim resume, cancel, reconcile or retry. Only the adapter may confirm quiescence/stopped execution. Requests do not stop processes or release capacity. Rebind and force recovery require maintainer authority and a reason. Unknown execution must remain uncertain. Reuse operation keys after lost responses and inspect current grant validity.",
    { request: AttemptRequestSchema },
    AttemptResultSchema,
    async ({ request }) => {
      const result = await executeAttemptRequest(facade.attempts, request);
      return {
        content: [{ type: "text", text: JSON.stringify({ result }) }],
        structuredContent: { result },
      };
    },
  );
}
