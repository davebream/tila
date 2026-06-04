import type {
  InstantiateTemplateRequest,
  InstantiateTemplateResponse,
} from "@tila/schemas";
import type { TilaClient } from "./client";

export function createTemplateMethods(client: TilaClient, projectId: string) {
  const base = `/projects/${projectId}/templates`;

  return {
    /** Instantiate an entity template. POST /projects/:id/templates/instantiate */
    async instantiate(
      req: InstantiateTemplateRequest,
    ): Promise<InstantiateTemplateResponse> {
      return client.post<InstantiateTemplateResponse>(
        `${base}/instantiate`,
        req,
      );
    },

    /** List available templates from the project schema. GET /projects/:id/templates */
    async list(): Promise<{
      ok: true;
      templates: Array<{
        name: string;
        type: string;
        description: string | null;
        variables: string[];
      }>;
    }> {
      return client.get<{
        ok: true;
        templates: Array<{
          name: string;
          type: string;
          description: string | null;
          variables: string[];
        }>;
      }>(base);
    },
  };
}
