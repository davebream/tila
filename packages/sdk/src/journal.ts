import type { JournalResponse } from "@tila/schemas";
import type { TilaClient } from "./client";

export function createJournalMethods(client: TilaClient, projectId: string) {
  const base = `/projects/${projectId}/journal`;

  return {
    async query(opts?: {
      entity_id?: string;
      event_kind?: string;
      limit?: string;
      cursor?: string;
    }): Promise<JournalResponse> {
      return client.get<JournalResponse>(base, { query: opts });
    },
  };
}
