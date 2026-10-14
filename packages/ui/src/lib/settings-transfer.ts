import {
  type SettingsPersist,
  type SettingsReadPort,
  appliedSettingsDefinition,
  createSettingsExecutionPort,
  executeSettingsTransfer,
} from "@tila/core";
import type { Agent, SettingsReceipt, SignalGroup } from "@tila/schemas";
import * as api from "./api";

export function browserSettingsTransfer(projectId: string) {
  const agent = async (id: string): Promise<Agent> => {
    const result = (
      await api.listAgents(projectId, { includeArchived: true })
    ).agents.find((v) => v.agent.id === id)?.agent;
    if (!result)
      throw new api.ApiError(
        "not-found",
        "Destination agent is not readable",
        undefined,
        404,
      );
    return result;
  };
  const group = async (id: string): Promise<SignalGroup> => {
    const result = (await api.listSignalGroups(projectId)).groups.find(
      (g) => g.id === id,
    );
    if (!result)
      throw new api.ApiError(
        "not-found",
        "Destination group is not readable",
        undefined,
        404,
      );
    return result;
  };
  const read: SettingsReadPort = {
    identity: api.whoami,
    principals: async () =>
      (await api.listMemberships(projectId)).memberships
        .filter((m) => m.revoked_at === null)
        .map((m) => m.principal_id),
    agents: async (includeArchived) =>
      (await api.listAgents(projectId, { includeArchived })).agents.map(
        (v) => v.agent,
      ),
    rooms: async (includeArchived) =>
      (await api.listRooms(projectId, { includeArchived })).rooms,
    room: (id) => api.getRoom(projectId, id),
    groups: async () => (await api.listSignalGroups(projectId)).groups,
    definitions: async () =>
      appliedSettingsDefinition(await api.getSchema(projectId)),
  };
  const execution = createSettingsExecutionPort(projectId, {
    identity: read.identity,
    principals: read.principals,
    agent,
    room: read.room,
    group,
    definitions: () => api.getSchema(projectId),
    applyDefinitions: (definition, strategy, options) =>
      api.applySchema(
        projectId,
        {
          definition,
          strategy,
          expected_revision: options.expected_revision as number,
          reviewed_definition: options.reviewed_definition,
        },
        options.idempotency_key,
      ),
    createAgent: async (input, key) =>
      (await api.registerAgent(projectId, input, key.idempotencyKey)).agent,
    updateAgent: async (id, input, key) =>
      (await api.updateAgent(projectId, id, input, key.idempotencyKey)).agent,
    createRoom: (input, key) =>
      api.createRoom(projectId, input, key.idempotencyKey),
    updateRoom: async (id, input, key) =>
      (await api.updateRoom(projectId, id, input, key.idempotencyKey)).room,
    setMember: async (id, member, wake, key) =>
      (
        await api.setRoomMember(
          projectId,
          id,
          member,
          { wake, expected_revision: key.expectedRevision as number },
          key.idempotencyKey,
        )
      ).room,
    removeMember: async (id, member, key) =>
      (
        await api.removeRoomMember(
          projectId,
          id,
          member,
          key.expectedRevision as number,
          key.idempotencyKey,
        )
      ).room,
    setGroup: async (id, input, key) =>
      (
        await api.putSignalGroup(
          projectId,
          id,
          { ...input, expected_revision: input.expected_revision as number },
          key.idempotencyKey,
        )
      ).group,
  });
  return {
    read,
    execute: (
      receipt: SettingsReceipt,
      persist: SettingsPersist,
      options?: { confirmRemovals?: boolean },
    ) => executeSettingsTransfer(execution, receipt, persist, options),
  };
}
