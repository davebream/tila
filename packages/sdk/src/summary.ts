import type { SummaryResponse } from "@tila/schemas";
import type { TilaClient } from "./client";

export function createSummaryMethods(client: TilaClient, projectId: string) {
  return {
    /** Get project summary. GET /projects/:id/summary */
    async get(): Promise<SummaryResponse> {
      return client.get<SummaryResponse>(`/projects/${projectId}/summary`);
    },
  };
}
