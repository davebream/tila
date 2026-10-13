import {
  AckSignalResponseSchema,
  InboxResponseSchema,
  type SendSignalRequest,
  SendSignalRequestSchema,
  SendSignalResponseSchema,
  type SetSignalGroupRequest,
  SetSignalGroupRequestSchema,
  SignalGroupIdSchema,
  SignalGroupResponseSchema,
  SignalGroupsResponseSchema,
  SignalHistoryResponseSchema,
} from "@tila/schemas";
import type { TilaClient } from "./client";

export function createSignalMethods(client: TilaClient, projectId: string) {
  const base = `/projects/${projectId}/signals`;

  return {
    /** Fetch the signal inbox for the current token. GET /projects/:id/signals */
    async inbox() {
      return client.get(base, { schema: InboxResponseSchema, validate: true });
    },

    /** Send a signal to a target. POST /projects/:id/signals/send */
    async send(req: SendSignalRequest) {
      const input = SendSignalRequestSchema.parse(req);
      return client.post(`${base}/send`, input, {
        schema: SendSignalResponseSchema,
        validate: true,
      });
    },

    /** Acknowledge a signal. POST /projects/:id/signals/:signalId/ack */
    async ack(signalId: string) {
      return client.post(
        `${base}/${signalId}/ack`,
        {},
        {
          schema: AckSignalResponseSchema,
          validate: true,
        },
      );
    },

    async history(options: { limit?: number; cursor?: string } = {}) {
      const query = new URLSearchParams();
      if (options.limit !== undefined)
        query.set("limit", String(options.limit));
      if (options.cursor) query.set("cursor", options.cursor);
      const suffix = query.size > 0 ? `?${query.toString()}` : "";
      return client.get(`${base}/history${suffix}`, {
        schema: SignalHistoryResponseSchema,
        validate: true,
      });
    },

    groups: {
      async list() {
        return client.get(`${base}/groups`, {
          schema: SignalGroupsResponseSchema,
          validate: true,
        });
      },
      async get(groupId: string) {
        const id = SignalGroupIdSchema.parse(groupId);
        return client.get(`${base}/groups/${encodeURIComponent(id)}`, {
          schema: SignalGroupResponseSchema,
          validate: true,
        });
      },
      /**
       * `expected_revision` 0 creates only; a positive value must match the
       * current revision. Omitted keeps the legacy unconditional replace.
       */
      async set(
        groupId: string,
        input: SetSignalGroupRequest,
        options: { idempotencyKey?: string } = {},
      ) {
        const id = SignalGroupIdSchema.parse(groupId);
        const body = SetSignalGroupRequestSchema.parse(input);
        return client.put(`${base}/groups/${encodeURIComponent(id)}`, body, {
          idempotencyKey: options.idempotencyKey ?? crypto.randomUUID(),
          schema: SignalGroupResponseSchema,
          validate: true,
        });
      },
      /** Never cancels or rewrites past deliveries. */
      async delete(
        groupId: string,
        options: { expected_revision?: number } = {},
      ) {
        const id = SignalGroupIdSchema.parse(groupId);
        const expected =
          SetSignalGroupRequestSchema.shape.expected_revision.parse(
            options.expected_revision,
          );
        return client.delete(`${base}/groups/${encodeURIComponent(id)}`, {
          query: {
            expected_revision:
              expected === undefined ? undefined : String(expected),
          },
          schema: AckSignalResponseSchema,
          validate: true,
        });
      },
    },
  };
}
