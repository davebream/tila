import type { JournalResponse } from "@tila/schemas";
import {
  type JournalAppendRequest,
  JournalAppendRequestSchema,
  JournalAppendResponseSchema,
  JournalIdempotencyKeySchema,
  journalValidationCode,
} from "@tila/schemas";
import type { TilaClient } from "./client";
import { createJournalContinuityMethods } from "./continuity";
import { TilaApiError } from "./errors";

export function createJournalMethods(client: TilaClient, projectId: string) {
  const base = `/projects/${projectId}/journal`;

  return {
    async append(
      input: JournalAppendRequest,
      options: { idempotencyKey: string },
    ) {
      const parsed = JournalAppendRequestSchema.safeParse(input);
      const key = JournalIdempotencyKeySchema.safeParse(options.idempotencyKey);
      if (!parsed.success) {
        const code = journalValidationCode(parsed.error);
        throw new TilaApiError(
          code === "payload-too-large" ? 413 : 400,
          code,
          parsed.error.message,
          false,
        );
      }
      if (!key.success)
        throw new TilaApiError(
          400,
          "validation-error",
          key.error.message,
          false,
        );
      return client.post(base, parsed.data, {
        idempotencyKey: key.data,
        schema: JournalAppendResponseSchema,
        validate: true,
      });
    },
    ...createJournalContinuityMethods(client, projectId),
    async query(opts?: {
      // Worker GET /journal query params: resource (entity id), kind (event
      // kind), after_seq (cursor), limit. These are the names the Worker route
      // actually reads — `entity_id`/`event_kind` were silently ignored.
      resource?: string;
      kind?: string;
      client_name?: string;
      event_name?: string;
      correlation_id?: string;
      after_seq?: string;
      limit?: string;
    }): Promise<JournalResponse> {
      return client.get<JournalResponse>(base, {
        query: {
          resource: opts?.resource,
          kind: opts?.kind,
          client_name: opts?.client_name,
          event_name: opts?.event_name,
          correlation_id: opts?.correlation_id,
          after_seq: opts?.after_seq,
          limit: opts?.limit,
        },
      });
    },
  };
}
