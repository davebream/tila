import type {
  ArchiveSuccessResponse,
  CreateEntityRelationshipResponse,
  EntityArtifactReferenceListResponse,
  EntityDetailResponse,
  EntityListResponse,
  EntityResponse,
} from "@tila/schemas";
import type { TilaClient } from "./client";

function _createMethods(client: TilaClient, base: string) {
  return {
    async create(
      id: string,
      type: string,
      data?: Record<string, unknown>,
    ): Promise<EntityResponse> {
      return client.post<EntityResponse>(base, { id, type, data });
    },

    async get(id: string): Promise<EntityDetailResponse> {
      return client.get<EntityDetailResponse>(`${base}/${id}`);
    },

    async list(query?: {
      type?: string;
      status?: string;
      limit?: string;
      cursor?: string;
    }): Promise<EntityListResponse> {
      return client.get<EntityListResponse>(base, { query });
    },

    async update(
      id: string,
      data: Record<string, unknown>,
      fence: number,
    ): Promise<EntityResponse> {
      return client.patch<EntityResponse>(`${base}/${id}`, { data, fence });
    },

    async archive(id: string, fence: number): Promise<ArchiveSuccessResponse> {
      return client.post<ArchiveSuccessResponse>(`${base}/${id}/archive`, {
        fence,
      });
    },

    async addRelationship(
      fromId: string,
      toId: string,
      type: string,
    ): Promise<CreateEntityRelationshipResponse> {
      return client.post<CreateEntityRelationshipResponse>(
        `${base}/${fromId}/relationships`,
        {
          to_id: toId,
          type,
        },
      );
    },

    async addArtifactRef(
      entityId: string,
      artifactKey: string,
      slot: string,
      metadata?: Record<string, unknown>,
    ): Promise<{ ok: true }> {
      return client.post<{ ok: true }>(`${base}/${entityId}/artifact-refs`, {
        artifact_key: artifactKey,
        slot,
        metadata,
      });
    },

    async listArtifactRefs(
      entityId: string,
    ): Promise<EntityArtifactReferenceListResponse> {
      return client.get<EntityArtifactReferenceListResponse>(
        `${base}/${entityId}/artifact-refs`,
      );
    },
  };
}

/**
 * Creates task API methods using the canonical /tasks public path.
 */
export function createTaskMethods(client: TilaClient, projectId: string) {
  return _createMethods(client, `/projects/${projectId}/tasks`);
}

/**
 * @deprecated Use createTaskMethods instead.
 */
export function createEntityMethods(client: TilaClient, projectId: string) {
  return _createMethods(client, `/projects/${projectId}/entities`);
}

/**
 * @deprecated Use createTaskMethods instead.
 */
export function createWorkUnitMethods(client: TilaClient, projectId: string) {
  return _createMethods(client, `/projects/${projectId}/work-units`);
}
