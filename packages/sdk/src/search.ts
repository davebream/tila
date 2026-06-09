import type { UnifiedSearchResponse } from "@tila/schemas";
import type { TilaClient } from "./client";

export function createSearchMethods(client: TilaClient, projectId: string) {
  const base = `/projects/${projectId}`;
  return {
    async search(
      q: string,
      opts?: { limit?: number; tagFilter?: string[] },
    ): Promise<UnifiedSearchResponse> {
      const query: Record<string, string> = { q };
      if (opts?.limit !== undefined) query.limit = String(opts.limit);
      if (opts?.tagFilter?.length) query.tag_filter = opts.tagFilter.join(",");
      return client.get<UnifiedSearchResponse>(`${base}/search`, { query });
    },
  };
}
