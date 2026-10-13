import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  AgentIdSchema,
  AgentRegistrationSchema,
  ArchiveAgentSchema,
  UpdateAgentSchema,
} from "@tila/schemas";
import type { TilaFacade } from "tila-sdk";
import { z } from "zod";
import { registerPrimitiveTool } from "../tool-registration";

const text = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
});
const idempotency = {
  idempotency_key: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe("Reuse only when retrying the same request after a lost reply"),
};

/**
 * Durable agent identity management (opt-in `agents` group). Writes name the
 * revision you read; a stale revision fails with revision-conflict and the
 * current revision instead of overwriting another change.
 */
export function registerAgentTools(
  server: McpServer,
  facade: Pick<TilaFacade, "agents">,
  _projectId: string,
): void {
  registerPrimitiveTool(
    server,
    "tila_agent_list",
    "List durable agents with their observed binding. Managers may include archived agents.",
    { include_archived: z.boolean().optional() },
    async ({ include_archived }) =>
      text(await facade.agents.list({ includeArchived: include_archived })),
  );
  registerPrimitiveTool(
    server,
    "tila_agent_get",
    "Read one agent: configured identity and policy (with its revision) and the observed binding.",
    { agent: AgentIdSchema, include_archived: z.boolean().optional() },
    async ({ agent, include_archived }) =>
      text(
        await facade.agents.get(agent, { includeArchived: include_archived }),
      ),
  );
  registerPrimitiveTool(
    server,
    "tila_agent_register",
    "Register a durable agent mailbox. Re-registering identical settings is a no-op; use tila_agent_update to change an existing agent.",
    {
      id: AgentIdSchema,
      name: z.string().min(1).max(100),
      bind_policy: z
        .array(z.object({ principal_id: z.string(), agent_id: AgentIdSchema }))
        .max(100)
        .optional(),
    },
    async (input) =>
      text(await facade.agents.register(AgentRegistrationSchema.parse(input))),
  );
  registerPrimitiveTool(
    server,
    "tila_agent_update",
    "Change an agent's name, binding grants or profile selection against expected_revision. Never replaces the active binding; a profile selection applies to the next new attach.",
    {
      agent: AgentIdSchema,
      expected_revision: UpdateAgentSchema.shape.expected_revision,
      name: UpdateAgentSchema.shape.name,
      bind_policy: UpdateAgentSchema.shape.bind_policy,
      profile_selection: UpdateAgentSchema.shape.profile_selection,
      ...idempotency,
    },
    async ({ agent, idempotency_key, ...input }) =>
      text(
        await facade.agents.update(agent, input, {
          idempotencyKey: idempotency_key,
        }),
      ),
  );
  registerPrimitiveTool(
    server,
    "tila_agent_archive_preview",
    "Show what archiving an agent would affect now: active binding, pending deliveries, rooms, open questions and unfinished attempts.",
    { agent: AgentIdSchema },
    async ({ agent }) => text(await facade.agents.archivePreview(agent)),
  );
  registerPrimitiveTool(
    server,
    "tila_agent_archive",
    "Archive an agent and release its active binding (expected_epoch from the preview) so the running session loses agent authority. Pending deliveries remain until they expire; attempts need explicit cancel or reassignment.",
    {
      agent: AgentIdSchema,
      ...ArchiveAgentSchema.shape,
      ...idempotency,
    },
    async ({ agent, idempotency_key, ...input }) =>
      text(
        await facade.agents.archive(agent, input, {
          idempotencyKey: idempotency_key,
        }),
      ),
  );
  registerPrimitiveTool(
    server,
    "tila_agent_unarchive",
    "Restore an archived agent's identity. No binding, lease or expired delivery is revived.",
    {
      agent: AgentIdSchema,
      expected_revision: z.number().int().positive(),
      ...idempotency,
    },
    async ({ agent, expected_revision, idempotency_key }) =>
      text(
        await facade.agents.unarchive(agent, expected_revision, {
          idempotencyKey: idempotency_key,
        }),
      ),
  );
}
