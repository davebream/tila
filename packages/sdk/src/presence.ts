import type {
  PresenceAllListResponse,
  PresenceHeartbeatSuccessResponse,
  PresenceListResponse,
} from "@tila/schemas";
import type { TilaClient } from "./client";

export function createPresenceMethods(client: TilaClient, projectId: string) {
  const base = `/projects/${projectId}/presence`;

  return {
    async heartbeat(
      info?: Record<string, unknown>,
    ): Promise<PresenceHeartbeatSuccessResponse> {
      return client.post<PresenceHeartbeatSuccessResponse>(
        `${base}/heartbeat`,
        {
          info: info ?? {},
        },
      );
    },

    async list(): Promise<PresenceListResponse> {
      return client.get<PresenceListResponse>(base);
    },

    /**
     * List all participant presence records, including whether each is active.
     * Hits GET /projects/:projectId/presence/all
     */
    async listAll(): Promise<PresenceAllListResponse> {
      return client.get<PresenceAllListResponse>(`${base}/all`);
    },
  };
}
