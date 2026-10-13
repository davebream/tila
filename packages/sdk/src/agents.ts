import {
  AgentArchivePreviewResponseSchema,
  AgentArchiveResponseSchema,
  AgentBindingResponseSchema,
  AgentGetResponseSchema,
  AgentIdSchema,
  AgentListResponseSchema,
  type AgentRegistration,
  AgentRegistrationResponseSchema,
  AgentRegistrationSchema,
  AgentResponseSchema,
  ArchiveAgentSchema,
  type AttachAgentBinding,
  AttachAgentBindingSchema,
  RuntimeViewQuerySchema,
  RuntimeViewResponseSchema,
  UnarchiveAgentSchema,
  UpdateAgentSchema,
} from "@tila/schemas";
import { z } from "zod";
import type { TilaClient } from "./client";

export function createAgentMethods(client: TilaClient, projectId: string) {
  const base = `/projects/${encodeURIComponent(projectId)}/agents`;
  const path = (id: string) =>
    `${base}/${encodeURIComponent(AgentIdSchema.parse(id))}`;
  const archived = (options: ReadOptions) => ({
    include_archived: options.includeArchived ? "true" : undefined,
  });
  // Every settings write carries a key so a transport retry replays the
  // committed result instead of conflicting with its own revision.
  const key = (options: WriteOptions) =>
    options.idempotencyKey ?? crypto.randomUUID();
  return {
    /** `includeArchived` is honored for agent managers only. */
    list: (options: ReadOptions = {}) =>
      client.get(base, {
        query: archived(options),
        schema: AgentListResponseSchema,
        validate: true,
      }),
    get: (id: string, options: ReadOptions = {}) =>
      client.get(path(id), {
        query: archived(options),
        schema: AgentGetResponseSchema,
        validate: true,
      }),
    /**
     * Change the configured name, binding grants or profile selection against
     * the reviewed `expected_revision`. Never replaces the active binding.
     */
    update: (
      id: string,
      input: z.input<typeof UpdateAgentSchema>,
      options: WriteOptions = {},
    ) =>
      client.patch(path(id), UpdateAgentSchema.parse(input), {
        idempotencyKey: key(options),
        schema: AgentResponseSchema,
        validate: true,
      }),
    /** What archiving would affect now (management only). */
    archivePreview: (id: string) =>
      client.get(`${path(id)}/archive-preview`, {
        schema: AgentArchivePreviewResponseSchema,
        validate: true,
      }),
    /**
     * Archive and release the active binding named by `expected_epoch` in one
     * step. Pending deliveries remain until they expire.
     */
    archive: (
      id: string,
      input: z.input<typeof ArchiveAgentSchema>,
      options: WriteOptions = {},
    ) =>
      client.post(`${path(id)}/archive`, ArchiveAgentSchema.parse(input), {
        idempotencyKey: key(options),
        schema: AgentArchiveResponseSchema,
        validate: true,
      }),
    /** Restore the identity only; no binding or lease is revived. */
    unarchive: (
      id: string,
      expectedRevision: number,
      options: WriteOptions = {},
    ) =>
      client.post(
        `${path(id)}/unarchive`,
        UnarchiveAgentSchema.parse({ expected_revision: expectedRevision }),
        {
          idempotencyKey: key(options),
          schema: AgentResponseSchema,
          validate: true,
        },
      ),
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
    /** Authorized runtime projection: bindings, runs, hosts and sessions. */
    runtimeView: (
      options: {
        limit?: number;
        cursor?: string;
        agent?: string;
        /** `attention`: only agents whose occupant needs a person. */
        filter?: "attention";
      } = {},
    ) => {
      const query = RuntimeViewQuerySchema.parse(options);
      return client.get(
        `/projects/${encodeURIComponent(projectId)}/runtime-view`,
        {
          query: {
            limit: String(query.limit),
            cursor: query.cursor,
            agent: query.agent,
            filter: query.filter,
          },
          schema: RuntimeViewResponseSchema,
          validate: true,
        },
      );
    },
  };
}

export interface ReadOptions {
  includeArchived?: boolean;
}
export interface WriteOptions {
  /** Reuse only to retry the same request; defaults to a fresh key. */
  idempotencyKey?: string;
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
    update: unsupported,
    archivePreview: unsupported,
    archive: unsupported,
    unarchive: unsupported,
    register: unsupported,
    bind: unsupported,
    release: unsupported,
    runtimeView: unsupported,
  };
}
