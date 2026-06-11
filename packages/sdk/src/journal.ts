import type { JournalResponse } from "@tila/schemas";
import type { TilaClient } from "./client";

export function createJournalMethods(client: TilaClient, projectId: string) {
  const base = `/projects/${projectId}/journal`;

  return {
    async query(opts?: {
      // Worker GET /journal query params: resource (entity id), kind (event
      // kind), after_seq (cursor), limit. These are the names the Worker route
      // actually reads — `entity_id`/`event_kind` were silently ignored.
      resource?: string;
      kind?: string;
      after_seq?: string;
      limit?: string;
    }): Promise<JournalResponse> {
      return client.get<JournalResponse>(base, {
        query: {
          resource: opts?.resource,
          kind: opts?.kind,
          after_seq: opts?.after_seq,
          limit: opts?.limit,
        },
      });
    },
  };
}
