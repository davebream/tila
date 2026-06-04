import type { UnifiedSearchResponse } from "@tila/schemas";
import type { TilaClient } from "./client";

export function createSearchMethods(client: TilaClient, projectId: string) {
  const base = `/projects/${projectId}`;
  return {
    async search(
      q: string,
      opts?: { limit?: number },
    ): Promise<UnifiedSearchResponse> {
      const query: Record<string, string> = { q };
      if (opts?.limit !== undefined) query.limit = String(opts.limit);
      return client.get<UnifiedSearchResponse>(`${base}/search`, { query });
    },
  };
}
