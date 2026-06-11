import type {
  ArchiveSuccessResponse,
  CreateEntityRelationshipResponse,
  EntityArtifactReferenceListResponse,
  EntityDetailResponse,
  EntityListResponse,
  EntityResponse,
  ListEntityRelationshipsResponse,
} from "@tila/schemas";
import type { TilaClient } from "./client";

function _createMethods(client: TilaClient, base: string) {
  return {
    async create(
      id: string,
      type: string,
      data?: Record<string, unknown>,
      tags?: string[],
    ): Promise<EntityResponse> {
      return client.post<EntityResponse>(base, {
        id,
        type,
        data,
        ...(tags !== undefined ? { tags } : {}),
      });
    },

    async get(id: string): Promise<EntityDetailResponse> {
      return client.get<EntityDetailResponse>(`${base}/${id}`);
    },

    async list(query?: {
      type?: string;
      status?: string;
      limit?: string;
      cursor?: string;
      tagFilter?: string[];
      /**
       * Request the Worker's compact projection (id/type/title/status/...). HTTP
       * only — the embedded backend has no compact list, so the local adapter
       * ignores this and returns full entities (a documented local divergence).
       */
      compact?: boolean;
    }): Promise<EntityListResponse> {
      const { tagFilter, compact, ...rest } = query ?? {};
      const q: Record<string, string | undefined> = { ...rest };
      if (tagFilter?.length) q.tag_filter = tagFilter.join(",");
      if (compact) q.compact = "true";
      return client.get<EntityListResponse>(base, { query: q });
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
      // The Worker exposes a COLLECTION relationship route
      // (POST /tasks/relationships with {from_id,to_id,type} in the body) — NOT
      // a per-id /tasks/:id/relationships route. `from_id` goes in the body.
      return client.post<CreateEntityRelationshipResponse>(
        `${base}/relationships`,
        {
          from_id: fromId,
          to_id: toId,
          type,
        },
      );
    },

    async listRelationships(filter?: {
      fromId?: string;
      toId?: string;
      type?: string;
    }): Promise<ListEntityRelationshipsResponse> {
      // GET /tasks/relationships with from_id/to_id/type filter query params.
      const query: Record<string, string | undefined> = {
        from_id: filter?.fromId,
        to_id: filter?.toId,
        type: filter?.type,
      };
      return client.get<ListEntityRelationshipsResponse>(
        `${base}/relationships`,
        { query },
      );
    },

    async ready(query?: {
      type?: string;
      parent?: string;
      limit?: number;
      includeSoftBlocked?: boolean;
    }): Promise<EntityListResponse> {
      const q: Record<string, string | undefined> = {
        type: query?.type,
        parent: query?.parent,
        limit: query?.limit !== undefined ? String(query.limit) : undefined,
      };
      if (query?.includeSoftBlocked) q["include-soft-blocked"] = "true";
      return client.get<EntityListResponse>(`${base}/ready`, { query: q });
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
