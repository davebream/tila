import {
  type HandoffCreateRequest,
  HandoffCreateRequestSchema,
  type HandoffListRequest,
  HandoffListRequestSchema,
  HandoffListResponseSchema,
  HandoffSchema,
  JournalAcknowledgeRequestSchema,
  JournalCursorSchema,
  type JournalReplayRequest,
  JournalReplayRequestSchema,
  JournalReplayResponseSchema,
  type ReentryRequest,
  ReentryRequestSchema,
  ReentryResponseSchema,
} from "@tila/schemas";
import { z } from "zod";
import type { TilaClient } from "./client";

export const cursorResponseSchema = z.object({
  ok: z.literal(true),
  cursor: JournalCursorSchema,
});
export const handoffResponseSchema = z.object({
  ok: z.literal(true),
  handoff: HandoffSchema,
});
export type CreateHandoffOptions = Omit<HandoffCreateRequest, "id"> & {
  id?: string;
};
const query = (input: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(input)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, String(value)]),
  );

export function createJournalContinuityMethods(
  client: TilaClient,
  projectId: string,
) {
  const base = `/projects/${projectId}/journal`;
  return {
    async replay(input: JournalReplayRequest) {
      return client.get(`${base}/replay`, {
        query: query(JournalReplayRequestSchema.parse(input)),
        schema: JournalReplayResponseSchema,
        validate: true,
      });
    },
    async getCursor() {
      return client.get(`${base}/cursor`, {
        schema: cursorResponseSchema,
        validate: true,
      });
    },
    async acknowledge(input: { seq: number }) {
      return client.put(
        `${base}/cursor`,
        JournalAcknowledgeRequestSchema.parse(input),
        { schema: cursorResponseSchema, validate: true },
      );
    },
  };
}
export function createHandoffMethods(client: TilaClient, projectId: string) {
  const base = `/projects/${projectId}/handoffs`;
  return {
    async create(input: CreateHandoffOptions) {
      const body = HandoffCreateRequestSchema.parse({
        ...input,
        id: input.id ?? crypto.randomUUID(),
      });
      return client.post(base, body, {
        schema: handoffResponseSchema,
        validate: true,
      });
    },
    async get(id: string) {
      return client.get(`${base}/${encodeURIComponent(id)}`, {
        schema: handoffResponseSchema,
        validate: true,
      });
    },
    async list(input: HandoffListRequest = {}) {
      return client.get(base, {
        query: query(HandoffListRequestSchema.parse(input)),
        schema: HandoffListResponseSchema,
        validate: true,
      });
    },
  };
}
export function createReentryMethod(client: TilaClient, projectId: string) {
  return async (input: ReentryRequest = {}) =>
    client.get(`/projects/${projectId}/reentry`, {
      query: query(ReentryRequestSchema.parse(input)),
      schema: ReentryResponseSchema,
      validate: true,
    });
}
