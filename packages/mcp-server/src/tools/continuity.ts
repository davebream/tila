import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  HandoffCreateRequestSchema,
  HandoffListRequestSchema,
  JournalAcknowledgeRequestSchema,
  JournalReplayRequestSchema,
  ReentryRequestSchema,
} from "@tila/schemas";
import type { TilaFacade } from "tila-sdk";
import { z } from "zod";
import { toMcpError } from "../errors";
import { registerPrimitiveTool } from "../tool-registration";

export function registerContinuityTools(
  server: McpServer,
  facade: TilaFacade,
  _projectId: string,
): void {
  const result = async (run: () => Promise<unknown>) => {
    try {
      return {
        content: [{ type: "text" as const, text: JSON.stringify(await run()) }],
      };
    } catch (error) {
      throw toMcpError(error);
    }
  };
  registerPrimitiveTool(
    server,
    "tila_reentry",
    "Recover project context, journal changes, live claims, pending signals and the newest work handoff, falling back to the newest shutdown snapshot. An explicit handoff_id selects that exact snapshot. Read-only: acknowledge events separately. Use an explicit handoff_id or resource when changing participants.",
    ReentryRequestSchema.innerType().shape,
    (input) => result(() => facade.reentry(ReentryRequestSchema.parse(input))),
  );
  registerPrimitiveTool(
    server,
    "tila_journal_replay",
    "Replay journal events oldest first, including archives. Continue using next_after_seq and the same through_seq.",
    JournalReplayRequestSchema.shape,
    (input) => result(() => facade.journal.replay(input)),
  );
  registerPrimitiveTool(
    server,
    "tila_journal_cursor_get",
    "Read this participant's durable acknowledged journal position.",
    {},
    () => result(() => facade.journal.getCursor()),
  );
  registerPrimitiveTool(
    server,
    "tila_journal_acknowledge",
    "Persist the last processed journal sequence for this participant. Never decreases the cursor.",
    JournalAcknowledgeRequestSchema.shape,
    (input) => result(() => facade.journal.acknowledge(input)),
  );
  registerPrimitiveTool(
    server,
    "tila_handoff_create",
    "Save an immutable factual handoff. Omit kind or use work for authored context; shutdown is for automatic coordination snapshots. Reuse the same UUID and content on retries. Claims are historical context, not transferred authority. Do not store private reasoning.",
    HandoffCreateRequestSchema.shape,
    (input) => result(() => facade.handoffs.create(input)),
  );
  registerPrimitiveTool(
    server,
    "tila_handoff_get",
    "Read an immutable handoff by ID, including handoffs from other participants in this project.",
    { id: z.string().uuid() },
    ({ id }) => result(() => facade.handoffs.get(id)),
  );
  registerPrimitiveTool(
    server,
    "tila_handoff_list",
    "List newest handoffs for this participant, or across participants for a resource (task:<id>, record:<type>:<key>, artifact:<key>, or claim resource).",
    HandoffListRequestSchema.shape,
    (input) => result(() => facade.handoffs.list(input)),
  );
}
