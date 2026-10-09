import {
  AgentBindingResponseSchema,
  AgentGetResponseSchema,
  AgentIdSchema,
  AgentListResponseSchema,
  type AgentRegistration,
  AgentRegistrationResponseSchema,
  AgentRegistrationSchema,
  type AttachAgentBinding,
  AttachAgentBindingSchema,
} from "@tila/schemas";
import { z } from "zod";
import type { TilaClient } from "./client";

export function createAgentMethods(client: TilaClient, projectId: string) {
  const base = `/projects/${encodeURIComponent(projectId)}/agents`;
  const path = (id: string) =>
    `${base}/${encodeURIComponent(AgentIdSchema.parse(id))}`;
  return {
    list: () =>
      client.get(base, { schema: AgentListResponseSchema, validate: true }),
    get: (id: string) =>
      client.get(path(id), { schema: AgentGetResponseSchema, validate: true }),
    register: (input: AgentRegistration) =>
      client.post(base, AgentRegistrationSchema.parse(input), {
        schema: AgentRegistrationResponseSchema,
        validate: true,
      }),
    bind: (id: string, input: AttachAgentBinding) =>
      client.post(`${path(id)}/bind`, AttachAgentBindingSchema.parse(input), {
        schema: AgentBindingResponseSchema,
        validate: true,
      }),
    release: (id: string, expectedEpoch: number) =>
      client.post(
        `${path(id)}/release`,
        { expected_epoch: z.number().int().positive().parse(expectedEpoch) },
        { schema: z.object({ ok: z.literal(true) }), validate: true },
      ),
  };
}

export class UnsupportedCapabilityError extends Error {
  readonly code = "unsupported-capability";
  readonly retryable = false;
  constructor() {
    super("Agent mailboxes require the Cloudflare backend");
  }
}
export function createUnsupportedAgentMethods(): ReturnType<
  typeof createAgentMethods
> {
  const unsupported = async (): Promise<never> => {
    throw new UnsupportedCapabilityError();
  };
  return {
    list: unsupported,
    get: unsupported,
    register: unsupported,
    bind: unsupported,
    release: unsupported,
  };
}
