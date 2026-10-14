import {
  createSettingsExecutionPort,
  executeSettingsTransfer,
} from "@tila/core/settings-execution";
import { type SettingsReceipt, WhoamiResponseSchema } from "@tila/schemas";
import { createMembershipMethods } from "./access";
import { createAgentMethods } from "./agents";
import type { TilaClient } from "./client";
import { createConversationMethods } from "./conversations";
import { createSchemaMethods } from "./schema";
import { createSignalMethods } from "./signals";

// No parser, YAML, filesystem or credentials enter this SDK surface. Consumers
// use core's pure planner and pass the exact reviewed plan to this executor.
export function createSettingsTransferMethods(
  client: TilaClient,
  projectId: string,
) {
  const agents = createAgentMethods(client, projectId);
  const rooms = createConversationMethods(client, projectId);
  const schema = createSchemaMethods(client, projectId);
  const groups = createSignalMethods(client, projectId).groups;
  const memberships = createMembershipMethods(client, projectId);
  const read = {
    identity: () =>
      client.get("/api/whoami", {
        // Legacy full tokens may report token_id:null. Transfer needs only
        // project/principal/access evidence, never credential identifiers.
        schema: WhoamiResponseSchema.omit({
          token_id: true,
          credential_id: true,
        }),
        validate: true,
      }),
    principals: async () =>
      (await memberships.list()).memberships
        .filter((m) => m.revoked_at === null)
        .map((m) => m.principal_id),
    agents: async (includeArchived: boolean) =>
      (await agents.list({ includeArchived })).agents.map((v) => v.agent),
    rooms: async (includeArchived: boolean) =>
      (await rooms.list(1, { includeArchived })).rooms,
    room: (id: string) => rooms.get(id),
    groups: async () => (await groups.list()).groups,
    // Definition parsing belongs to core/the consumer, preserving a zod-only
    // SDK bundle. Expose the existing service response rather than guessing.
    definitions: () => schema.get(),
  };
  const execution = createSettingsExecutionPort(projectId, {
    identity: read.identity,
    principals: read.principals,
    agent: async (id) => (await agents.get(id)).agent,
    room: read.room,
    group: async (id) => (await groups.get(id)).group,
    definitions: read.definitions,
    applyDefinitions: schema.apply,
    createAgent: async (input) => (await agents.register(input)).agent,
    updateAgent: async (id, input, key) =>
      (await agents.update(id, input, key)).agent,
    createRoom: (input) => rooms.create(input),
    updateRoom: async (id, input, key) =>
      (await rooms.update(id, input, key)).room,
    setMember: async (id, member, wake, key) =>
      (await rooms.join(id, member, wake, key)).room,
    removeMember: async (id, member, key) =>
      (await rooms.leave(id, member, key)).room,
    setGroup: async (id, input, key) =>
      (await groups.set(id, input, key)).group,
  });
  return {
    read,
    execute: (
      receipt: SettingsReceipt,
      persist: (receipt: SettingsReceipt) => Promise<void> | void,
      options?: { confirmRemovals?: boolean },
    ) => executeSettingsTransfer(execution, receipt, persist, options),
  };
}
export type SettingsTransferMethods = ReturnType<
  typeof createSettingsTransferMethods
>;
