import type { TilaClient } from "./client";

export function createSchemaMethods(client: TilaClient, projectId: string) {
  const base = `/projects/${projectId}/schema`;

  return {
    async get(): Promise<{ ok: true; schema: unknown; version: number }> {
      return client.get(base);
    },

    async apply(
      schema: unknown,
      strategy?: string,
    ): Promise<{ ok: true; version: number; diff: unknown }> {
      return client.post(`${base}/apply`, { schema, strategy });
    },

    async history(opts?: { limit?: string }): Promise<{
      ok: true;
      entries: unknown[];
    }> {
      return client.get(`${base}/history`, { query: opts });
    },
  };
}
