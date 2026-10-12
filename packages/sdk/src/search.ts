import type { SearchKind, UnifiedSearchResponse } from "@tila/schemas";
import type { TilaClient } from "./client";

export interface SearchOptions {
  limit?: number;
  tagFilter?: string[];
  kind?: SearchKind[];
  type?: string[];
  cursor?: string;
  syntax?: "fts" | "literal";
}

export function createSearchMethods(client: TilaClient, projectId: string) {
  const base = `/projects/${projectId}`;
  return {
    /**
     * Unified search. `kind` narrows to tasks, records or artifacts; `type`
     * narrows one task or record kind to types; `cursor` continues from a
     * previous `next_cursor`; `syntax: "literal"` treats `q` as plain words.
     */
    async search(
      q: string,
      opts?: SearchOptions,
    ): Promise<UnifiedSearchResponse> {
      const query: Record<string, string> = { q };
      if (opts?.limit !== undefined) query.limit = String(opts.limit);
      if (opts?.tagFilter?.length) query.tag_filter = opts.tagFilter.join(",");
      if (opts?.kind?.length) query.kind = opts.kind.join(",");
      if (opts?.type?.length) query.type = opts.type.join(",");
      if (opts?.cursor) query.cursor = opts.cursor;
      if (opts?.syntax) query.syntax = opts.syntax;
      return client.get<UnifiedSearchResponse>(`${base}/search`, { query });
    },
  };
}
