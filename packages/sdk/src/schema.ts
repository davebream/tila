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
      // The Worker mounts schema apply at POST /schema (NOT /schema/apply), and
      // reads the TOML from the `definition` body field (NOT `schema`). The DO
      // hop behind it is /schema/apply, but the public Worker route is /schema.
      const definition =
        typeof schema === "string" ? schema : JSON.stringify(schema);
      return client.post(base, { definition, strategy });
    },

    async history(opts?: { limit?: string }): Promise<{
      ok: true;
      entries: unknown[];
    }> {
      return client.get(`${base}/history`, { query: opts });
    },
  };
}
