import type { ApplySchemaInput } from "@tila/core";
import type {
  SchemaApplyResponse,
  SchemaGetResponse,
  SchemaHistoryResponse,
  SchemaPreviewResponse,
} from "@tila/schemas";
import type { TilaClient } from "./client";

export function createSchemaMethods(client: TilaClient, projectId: string) {
  const base = `/projects/${projectId}/schema`;

  return {
    async get(): Promise<SchemaGetResponse> {
      return client.get(base);
    },

    async apply(
      schema: unknown,
      strategy?: string,
      options?: Omit<ApplySchemaInput, "definition" | "strategy">,
    ): Promise<SchemaApplyResponse> {
      // The Worker mounts schema apply at POST /schema (NOT /schema/apply), and
      // reads the TOML from the `definition` body field (NOT `schema`). The DO
      // hop behind it is /schema/apply, but the public Worker route is /schema.
      const definition =
        typeof schema === "string" ? schema : JSON.stringify(schema);
      return client.post(base, { definition, strategy, ...options });
    },

    async preview(definition: string): Promise<SchemaPreviewResponse> {
      return client.post(`${base}/preview`, { definition });
    },

    async history(opts?: {
      limit?: string;
      before?: string;
    }): Promise<SchemaHistoryResponse> {
      return client.get(`${base}/history`, { query: opts });
    },
  };
}
