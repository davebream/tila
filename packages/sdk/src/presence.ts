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
      machine: string,
      info?: Record<string, unknown>,
    ): Promise<PresenceHeartbeatSuccessResponse> {
      // Worker route is POST /presence/heartbeat (NOT /presence, which is the
      // GET list). The Worker derives the machine from the token and reads
      // `info` from the body; `machine` is sent for parity but the server may
      // override it from the bearer-token identity.
      return client.post<PresenceHeartbeatSuccessResponse>(
        `${base}/heartbeat`,
        {
          machine,
          info: info ?? {},
        },
      );
    },

    async list(): Promise<PresenceListResponse> {
      return client.get<PresenceListResponse>(base);
    },

    /**
     * List all presence records across all machines, including whether each is active.
     * Hits GET /projects/:projectId/presence/all
     */
    async listAll(): Promise<PresenceAllListResponse> {
      return client.get<PresenceAllListResponse>(`${base}/all`);
    },
  };
}
