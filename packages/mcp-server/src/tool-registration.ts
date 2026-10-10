import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  CallToolResult,
  ToolAnnotations,
} from "@modelcontextprotocol/sdk/types.js";
import {
  McpPrimitiveResults,
  type McpRecovery,
  McpRecoverySchema,
} from "@tila/schemas";
import { TilaApiError } from "tila-sdk";
import { z } from "zod";

const reads = new Set([
  "tila_room_list",
  "tila_room_history",
  "tila_inbox_fetch",
  "tila_inbox_watch",
  "tila_inbox_explain",
  "tila_task_list",
  "tila_task_show",
  "tila_task_ready",
  "tila_task_relationships_list",
  "tila_claim_list",
  "tila_artifact_read_text",
  "tila_artifact_search",
  "tila_artifact_grep",
  "tila_artifact_get_latest",
  "tila_artifact_relationships_list",
  "tila_artifact_history",
  "tila_artifact_reviews",
  "tila_search",
  "tila_record_get",
  "tila_record_list",
  "tila_record_history",
  "tila_summary",
  "tila_signal_list",
  "tila_signal_history",
  "tila_signal_group_list",
  "tila_signal_group_get",
  "tila_journal_list",
  "tila_template_list",
  "tila_reentry",
  "tila_journal_replay",
  "tila_journal_cursor_get",
  "tila_handoff_get",
  "tila_handoff_list",
  "tila_inspect",
]);
const additive = new Set([
  "tila_room_publish",
  "tila_task_create",
  "tila_artifact_put",
  "tila_artifact_write_text",
  "tila_signal_send",
  "tila_handoff_create",
  "tila_template_instantiate",
  "tila_gate_create",
]);
const idempotent = new Set([
  "tila_room_publish",
  "tila_inbox_ack",
  "tila_journal_acknowledge",
  "tila_handoff_create",
  "tila_signal_ack",
]);
export function toolAnnotations(name: string): ToolAnnotations {
  const readOnlyHint = reads.has(name);
  return {
    readOnlyHint,
    destructiveHint: !readOnlyHint && !additive.has(name),
    idempotentHint: readOnlyHint || idempotent.has(name),
    openWorldHint:
      name === "tila_signal" ||
      name === "tila_signal_send" ||
      name === "tila_room_publish",
  };
}

export function recoveryFor(error: unknown, readOnly = false): McpRecovery {
  const cause = error instanceof Error && error.cause ? error.cause : error;
  const message = cause instanceof Error ? cause.message : String(cause);
  const candidate = cause as {
    code?: unknown;
    status?: number;
    retryable?: boolean;
  } | null;
  const localCodes: Record<string, string> = {
    FenceError: "stale-fence",
    ExpiredClaimError: "stale-fence",
    ClaimOwnershipError: "release-ownership-denied",
    FenceNotFoundError: "no-fence",
    RecordAlreadyExistsError: "record-already-exists",
    RecordNotFoundError: "not-found",
    EntityAlreadyExistsError: "entity-already-exists",
    EntityNotFoundError: "not-found",
    LocalUnsupportedError: "unsupported-backend",
  };
  const localCode = cause instanceof Error ? localCodes[cause.name] : undefined;
  const code =
    localCode ??
    (typeof candidate?.code === "string"
      ? candidate.code
      : /requires a remote backend|not supported.*local|LocalUnsupported/i.test(
            message,
          )
        ? "unsupported-backend"
        : /lifecycle degraded/i.test(message)
          ? "lifecycle-unavailable"
          : cause instanceof z.ZodError
            ? "validation-error"
            : "unknown");
  let recovery_action = readOnly
    ? "Retry the read. If it fails again, inspect project connectivity."
    : "Inspect current state before retrying; the mutation may already have committed.";
  let retry_safety: McpRecovery["retry_safety"] = readOnly ? "safe" : "unknown";
  const conversationRecovery: Record<string, string> = {
    "unsupported-protocol":
      "Negotiate conversation_protocols from /api/runtime/info and use a supported conversation protocol; runtime protocol is separate.",
    "cursor-expired":
      "Restart history from a fresh cursor. Fetch the inbox without a cursor to recover pending deliveries; do not infer acknowledgement from history.",
    "delivery-expired":
      "Inspect delivery history. Do not act on this expired delivery; ask the publisher for a new message if work is still needed.",
    "body-too-large":
      "Store large content as an artifact and publish its reference with a body of at most 64 KB.",
  };
  if (Object.hasOwn(conversationRecovery, code))
    return {
      code,
      message,
      retry_safety: "after_recovery",
      recovery_action: conversationRecovery[code],
    };
  if (
    [
      "stale-binding",
      "no-active-binding",
      "runtime-required",
      "profile-mismatch",
      "unsupported-capability",
    ].includes(code)
  ) {
    return {
      code,
      message,
      retry_safety: "after_recovery",
      recovery_action:
        code === "unsupported-capability"
          ? "Use a Cloudflare project and a client/runtime that supports this capability."
          : "Inspect the agent and selected profile. Start an authorized run and attach using the current binding epoch before retrying.",
    };
  }
  if (
    [
      "stale-fence",
      "no-fence",
      "renew-failed",
      "release-ownership-denied",
      "already-held",
      "gate-fence-conflict",
    ].includes(code)
  ) {
    recovery_action =
      "Inspect current claims and state. Stop writing with the old fence; acquire a new claim only when available, then reconcile changes before writing.";
    retry_safety = "after_recovery";
  } else if (
    candidate?.status === 401 ||
    candidate?.status === 403 ||
    /^(unauthorized|session-expired|session-revoked|subject-revoked|permission-denied|permission-revoked|forbidden|lifecycle-unavailable)$/.test(
      code,
    )
  ) {
    recovery_action =
      code === "lifecycle-unavailable"
        ? "Restore the client lifecycle session before retrying; do not substitute another participant."
        : "Restore authentication and project access before retrying.";
    retry_safety = "after_recovery";
  } else if (code === "unsupported-backend") {
    recovery_action =
      "Use the supported text-artifact operation locally, or select a Cloudflare project for this operation.";
    retry_safety = "unsafe";
  } else if (
    /invalid|validation|conflict|not-found|already-exists|no-active-recipients/.test(
      code,
    )
  ) {
    recovery_action =
      "Inspect the referenced state and correct the request. Reuse an idempotency key only with its original content.";
    retry_safety = "after_recovery";
  } else if (code === "journal-history-unavailable") {
    recovery_action =
      "Retry the same replay range after archive access recovers. Do not advance the cursor past missing history.";
    retry_safety = "safe";
  } else if (cause instanceof TilaApiError && cause.status === 429) {
    recovery_action =
      "Wait for the rate limit to clear, then retry the same request.";
    retry_safety = "safe";
  }
  return { code, message, recovery_action, retry_safety };
}
export function toolFailure(error: unknown, readOnly = false): CallToolResult {
  const structuredContent = { error: recoveryFor(error, readOnly) };
  return {
    isError: true,
    structuredContent,
    content: [{ type: "text", text: JSON.stringify(structuredContent) }],
  };
}

export function registerResultTool<S extends z.ZodRawShape>(
  server: McpServer,
  name: string,
  description: string,
  inputSchema: S,
  resultSchema: z.ZodTypeAny,
  handler: (input: z.output<z.ZodObject<S>>) => Promise<CallToolResult>,
): void {
  const annotations = toolAnnotations(name);
  server.registerTool(
    name,
    {
      description,
      inputSchema: z.object(inputSchema),
      outputSchema: z.object({
        result: resultSchema.optional(),
        error: McpRecoverySchema.optional(),
      }),
      annotations,
    },
    async (input) => {
      try {
        const response = await handler(input as z.output<z.ZodObject<S>>);
        if (response.isError) return response;
        const parsed = resultSchema.safeParse(
          response.structuredContent?.result,
        );
        if (!parsed.success) {
          // A backend mutation may already have committed before output validation.
          return toolFailure(
            new Error(`Invalid result for ${name}: ${parsed.error.message}`),
            annotations.readOnlyHint,
          );
        }
        return { ...response, structuredContent: { result: parsed.data } };
      } catch (error) {
        return toolFailure(error, annotations.readOnlyHint);
      }
    },
  );
}

/** Preserve existing human-readable content, add a typed machine-readable result. */
export function registerPrimitiveTool<S extends z.ZodRawShape>(
  server: McpServer,
  name: string,
  description: string,
  input: S,
  handler: (args: z.output<z.ZodObject<S>>) => Promise<CallToolResult>,
): void {
  const schema = McpPrimitiveResults[name as keyof typeof McpPrimitiveResults];
  if (!schema) throw new Error(`Missing output contract for ${name}`);
  registerResultTool(server, name, description, input, schema, async (args) => {
    const response = await handler(args);
    const texts = response.content.filter((c) => c.type === "text");
    const result =
      name === "tila_artifact_read_text"
        ? {
            ...JSON.parse(texts[0]?.text ?? "{}"),
            content: texts[1]?.text ?? "",
            truncated: /\.\.\.\[truncated: returned/.test(texts[1]?.text ?? ""),
          }
        : JSON.parse(texts[0]?.text ?? "null");
    // The registration wrapper validates and normalizes the machine-readable result.
    return { ...response, structuredContent: { result } };
  });
}
