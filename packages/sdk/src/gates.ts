import type {
  CreateGateRequest,
  GateListResponse,
  GateResponse,
  ResolveGateRequest,
} from "@tila/schemas";
import type { TilaClient } from "./client";

export function createGateMethods(client: TilaClient, projectId: string) {
  const base = `/projects/${projectId}/gates`;

  return {
    /** List gates with optional filters. GET /projects/:id/gates */
    async list(query?: {
      resource?: string;
      status?: string;
      limit?: string;
    }): Promise<GateListResponse> {
      return client.get<GateListResponse>(base, { query });
    },

    /** Create a new gate. POST /projects/:id/gates */
    async create(req: CreateGateRequest): Promise<GateResponse> {
      return client.post<GateResponse>(base, req);
    },

    /** Resolve a gate. POST /projects/:id/gates/:gateId/resolve */
    async resolve(
      gateId: string,
      req?: ResolveGateRequest,
    ): Promise<GateResponse> {
      return client.post<GateResponse>(`${base}/${gateId}/resolve`, req ?? {});
    },

    /** Delete a gate. DELETE /projects/:id/gates/:gateId */
    async remove(gateId: string): Promise<{ ok: true }> {
      return client.delete<{ ok: true }>(`${base}/${gateId}`);
    },
  };
}
