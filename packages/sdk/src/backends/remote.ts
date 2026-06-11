import type {
  AcquireResult,
  AddArtifactRefInput,
  ApplySchemaInput,
  ApplySchemaOutput,
  ArchiveRecordInput,
  ArtifactBackend,
  ArtifactIndexEntry,
  ArtifactPointerRecord,
  ArtifactPutOptions,
  ArtifactRelationship,
  ArtifactSearchResultRecord,
  CoordinationBackend,
  CreateEntityInput,
  CreateRecordInput,
  EntityBackend,
  EntityListFilter,
  EntityTree,
  GateBackend,
  GateFilter,
  GateRecord,
  JournalBackend,
  JournalEvent,
  JournalQuery,
  PatchRecordInput,
  ProjectSummary,
  ReadyFilter,
  RecordBackend,
  RecordHistoryOptions,
  RecordListFilter,
  RecordPage,
  RelationshipFilter,
  RelationshipInput,
  RenewResult,
  SchemaBackend,
  SchemaRecord,
  SendSignalInput,
  SetRecordInput,
  SignalBackend,
  SignalRecord,
  SummaryBackend,
} from "@tila/core";
import type {
  ArtifactGrepResponse,
  Claim,
  Entity,
  EntityArtifactReference,
  EntityRelationship,
  Presence,
  RecordHistoryItem,
  RecordListItem,
  RecordRow,
} from "@tila/schemas";
import {
  AckSignalResponseSchema,
  AcquireSuccessResponseSchema,
  ArchiveSuccessResponseSchema,
  ArtifactGrepResponseSchema,
  ArtifactPutResponseSchema,
  CreateEntityRelationshipResponseSchema,
  DeleteEntityRelationshipResponseSchema,
  EntityArtifactReferenceListResponseSchema,
  EntityDetailResponseSchema,
  EntityResponseSchema,
  GateListResponseSchema,
  GateResponseSchema,
  InboxResponseSchema,
  JournalResponseSchema,
  ListEntityRelationshipsResponseSchema,
  ListReadyEntitiesResponseSchema,
  PaginatedCompactEntityListResponseSchema,
  PaginatedEntityListResponseSchema,
  PresenceAllListResponseSchema,
  PresenceHeartbeatSuccessResponseSchema,
  RecordGetResponseSchema,
  RecordHistoryResponseSchema,
  RecordListResponseSchema,
  RecordMutateResponseSchema,
  ReleaseSuccessResponseSchema,
  RenewSuccessResponseSchema,
  SendSignalResponseSchema,
  StateResponseSchema,
  SummaryResponseSchema,
} from "@tila/schemas";
import { z } from "zod";
import { TilaApiError, type TilaClient } from "../client";

// Internal schemas for artifact endpoints not exported from @tila/schemas.
//
// The Worker `/artifacts` list route forwards to the DO `/artifact/list`
// handler, which returns the FULL pointer shape from `artifactOps.listPointers`
// (every `ArtifactPointerRecord` field, plus `fence` + `tags`). This schema
// validates all ten `ArtifactPointerRecord` fields so `listPointers`' cast to
// `ArtifactPointerRecord[]` is backed by real validation, not an unchecked
// `as unknown as`. `.passthrough()` retains the extra `fence`/`tags` fields.
const ArtifactPointerInternalSchema = z
  .object({
    r2_key: z.string(),
    resource: z.string().nullable(),
    kind: z.string(),
    sha256: z.string(),
    bytes: z.number(),
    mime_type: z.string(),
    produced_at: z.number(),
    produced_by: z.string(),
    expires_at: z.number().nullable(),
    tombstoned: z.number(),
  })
  .passthrough();

const ArtifactListInternalSchema = z.object({
  ok: z.literal(true),
  pointers: z.array(ArtifactPointerInternalSchema),
});

const OkSchema = z.object({ ok: z.literal(true) }).passthrough();

// /records/_types returns the merged declared∪in-use `types` plus the
// `in_use_types` subset. Per the RecordBackend contract,
// listRecordTypesInUse() returns the IN-USE subset only (`in_use_types`) —
// consistent with EmbeddedProject. The CLI composes the merged view from the
// schema's declared types when it needs it.
const RecordTypesInternalSchema = z.object({
  ok: z.literal(true),
  types: z.array(z.string()),
  in_use_types: z.array(z.string()).optional(),
});

const SchemaShowResponseSchema = z.object({
  ok: z.literal(true),
  schema: z.record(z.unknown()).nullable(),
  version: z.number().int().nullable(),
});

const SchemaApplyLenientSchema = z.object({
  ok: z.literal(true),
  version: z.number().int().nullable().optional(),
  changes: z.array(z.string()).optional(),
  noChange: z.boolean().optional(),
});

const StateListInternalSchema = z.object({
  ok: z.literal(true),
  claims: z.array(
    z.object({
      resource: z.string(),
      machine: z.string(),
      user: z.string(),
      mode: z.enum(["exclusive", "owner", "presence"]),
      fence: z.number(),
      acquired_at: z.number(),
      expires_at: z.number(),
      metadata: z.record(z.unknown()).optional(),
    }),
  ),
});

const ArtifactSearchResponseSchema = z.object({
  ok: z.literal(true),
  results: z.array(
    z
      .object({
        r2_key: z.string(),
        kind: z.string(),
        title: z.string().nullable(),
        snippet: z.string().nullable(),
      })
      .passthrough(),
  ),
});

const RelListResponseSchema = z.object({
  ok: z.literal(true),
  relationships: z.array(
    z
      .object({
        from_key: z.string(),
        to_key: z.string().nullable(),
        to_uri: z.string().nullable(),
        type: z.string(),
        created_at: z.number(),
      })
      .passthrough(),
  ),
});

const IndexEntriesResponseSchema = z.object({
  ok: z.literal(true),
  entries: z.array(
    z.object({
      r2_key: z.string(),
      resource: z.string().nullable(),
      kind: z.string(),
      sha256: z.string(),
      bytes: z.number(),
      mime_type: z.string(),
      produced_at: z.number(),
      produced_by: z.string(),
      expires_at: z.number().nullable(),
      tombstoned: z.number(),
      exists: z.boolean(),
    }),
  ),
});

/**
 * RemoteBackend implements EntityBackend, CoordinationBackend, and the five
 * new domain backends (JournalBackend, GateBackend, SignalBackend, SchemaBackend,
 * SummaryBackend) by delegating to TilaClient HTTP calls and unwrapping response
 * envelopes.
 *
 * ArtifactBackend is intentionally NOT implemented here because EntityBackend
 * and ArtifactBackend both declare `get` and `list` with incompatible return
 * types — a single class cannot satisfy both interfaces simultaneously.
 * See RemoteArtifactBackend below.
 */
export class RemoteBackend
  implements
    EntityBackend,
    CoordinationBackend,
    JournalBackend,
    GateBackend,
    SignalBackend,
    SchemaBackend,
    SummaryBackend
{
  constructor(
    private client: TilaClient,
    private projectId: string,
  ) {}

  // --- EntityBackend ---

  async create(input: CreateEntityInput): Promise<Entity> {
    const body: Record<string, unknown> = {
      id: input.id,
      type: input.type,
      data: input.data,
      created_by: input.created_by,
    };
    // Forward tags so create-time tagging is at parity with EmbeddedProject;
    // the Worker create route persists them (CreateEntityRequestSchema.tags).
    if (input.tags !== undefined) body.tags = input.tags;
    const result = await this.client.post(
      `/projects/${this.projectId}/tasks`,
      body,
      { schema: EntityResponseSchema, validate: true },
    );
    return result.entity;
  }

  async get(id: string): Promise<Entity | null> {
    try {
      const result = await this.client.get(
        `/projects/${this.projectId}/tasks/${encodeURIComponent(id)}`,
        { schema: EntityDetailResponseSchema, validate: true },
      );
      return result.entity;
    } catch (err) {
      if (err instanceof TilaApiError && err.status === 404) {
        return null;
      }
      throw err;
    }
  }

  async list(filter?: EntityListFilter): Promise<Entity[]> {
    const query: Record<string, string | undefined> = {};
    if (filter?.type) query.type = filter.type;
    if (filter?.archived !== undefined)
      query.archived = String(filter.archived);
    // Flatten dataFilter keys to the Worker's list query params.
    //
    // CONTRACT: `EntityBackend.list` dataFilter keys are DATA-FIELD names
    // (e.g. `parent_id`, `status`) — the same names EmbeddedProject applies
    // directly via `json_extract(data, '$.<key>')`. The Worker list route
    // (packages/worker/src/routes/entities.ts) only reads a fixed set of
    // query params and the DO maps some of them onto data fields, so a few
    // data-field names differ from their query-param name. Translate those:
    //   - `parent_id` (data field) -> `parent` (query param the Worker reads,
    //     which the DO maps back to `dataFilter.parent_id`).
    //   - `status` is identical on both sides; all other keys pass through.
    const DATA_FIELD_TO_QUERY_PARAM: Record<string, string> = {
      parent_id: "parent",
    };
    if (filter?.dataFilter) {
      for (const [key, value] of Object.entries(filter.dataFilter)) {
        if (value !== undefined && value !== null) {
          const param = DATA_FIELD_TO_QUERY_PARAM[key] ?? key;
          query[param] = String(value);
        }
      }
    }
    // Tag filter: serialize to the Worker's `tag_filter` query param (comma-
    // joined), which the list route honors (worker entities.ts ~196). Mirrors
    // the SDK entities factory and keeps tasks.list tag filtering at parity with
    // EmbeddedProject (which applies tagFilter via entityOps.list).
    if (filter?.tagFilter?.length)
      query.tag_filter = filter.tagFilter.join(",");
    // Pagination and sorting params
    if (filter?.sort) query.sort = filter.sort;
    if (filter?.order) query.order = filter.order;
    if (filter?.limit !== undefined) query.limit = String(filter.limit);
    if (filter?.offset !== undefined) query.offset = String(filter.offset);
    const result = await this.client.get(`/projects/${this.projectId}/tasks`, {
      schema: PaginatedEntityListResponseSchema,
      validate: true,
      query,
    });
    return result.entities;
  }

  async update(id: string, data: Partial<Entity["data"]>): Promise<Entity> {
    // Auto-acquire a fence using bare entity ID as the claim resource.
    // assertResourceFence in fence-ops.ts supports both bare-id and typed-resource
    // lookup, so the bare id is sufficient without an extra get() call to resolve type.
    const acquired = await this.acquire(id, "cli", "cli", "exclusive", 30_000);
    try {
      const result = await this.client.patch(
        `/projects/${this.projectId}/tasks/${encodeURIComponent(id)}`,
        { data, fence: acquired.fence },
        { schema: EntityResponseSchema, validate: true },
      );
      return result.entity;
    } finally {
      // Best-effort release -- if the entity was archived, the claim was already deleted
      try {
        await this.release(id, acquired.fence);
      } catch {
        // Idempotent -- claim may already be gone
      }
    }
  }

  async archive(id: string): Promise<void> {
    // Auto-acquire a fence; archive() deletes the claim inside its transaction,
    // so no explicit release is needed after a successful archive.
    const acquired = await this.acquire(id, "cli", "cli", "exclusive", 30_000);
    await this.client.post(
      `/projects/${this.projectId}/tasks/${encodeURIComponent(id)}/archive`,
      { fence: acquired.fence },
      { schema: ArchiveSuccessResponseSchema, validate: true },
    );
    // No release -- server deletes claim row atomically inside archive transaction
  }

  async addRelationship(
    input: RelationshipInput,
  ): Promise<{ created: boolean }> {
    const result = await this.client.post(
      `/projects/${this.projectId}/tasks/relationships`,
      { from_id: input.from_id, to_id: input.to_id, type: input.type },
      { schema: CreateEntityRelationshipResponseSchema, validate: true },
    );
    // `created` defaults to true in the schema (back-compat with older responses).
    return { created: result.created ?? true };
  }

  async listRelationships(
    filter?: RelationshipFilter,
  ): Promise<EntityRelationship[]> {
    const query: Record<string, string | undefined> = {};
    if (filter?.from_id) query.from_id = filter.from_id;
    if (filter?.to_id) query.to_id = filter.to_id;
    if (filter?.type) query.type = filter.type;
    const result = await this.client.get(
      `/projects/${this.projectId}/tasks/relationships`,
      { schema: ListEntityRelationshipsResponseSchema, validate: true, query },
    );
    return result.relationships;
  }

  async removeRelationship(
    input: RelationshipInput,
  ): Promise<{ removed: boolean }> {
    // client.delete carries no body/query option, so encode the composite key
    // into the path. The Worker reads from_id/to_id/type from the query string.
    const params = new URLSearchParams({
      from_id: input.from_id,
      to_id: input.to_id,
      type: input.type,
    });
    const result = await this.client.delete(
      `/projects/${this.projectId}/tasks/relationships?${params.toString()}`,
      { schema: DeleteEntityRelationshipResponseSchema, validate: true },
    );
    return { removed: result.removed };
  }

  // GET /projects/:projectId/tasks/ready (worker entities.ts ~129 -> DO /entity/ready)
  async listReady(filter?: ReadyFilter): Promise<Entity[]> {
    const query: Record<string, string | undefined> = {};
    if (filter?.type) query.type = filter.type;
    if (filter?.parent) query.parent = filter.parent;
    if (filter?.limit !== undefined) query.limit = String(filter.limit);
    if (filter?.includeSoftBlocked) query["include-soft-blocked"] = "true";
    const result = await this.client.get(
      `/projects/${this.projectId}/tasks/ready`,
      { schema: ListReadyEntitiesResponseSchema, validate: true, query },
    );
    // The ready response omits `tags` (parity with readyOps.computeReadyEntities,
    // which returns tags: []). Backfill so each item satisfies `Entity`.
    return result.entities.map((e) => ({ ...e, tags: [] }));
  }

  // Tree = compact list (GET /tasks?compact=true) + parent-child edges
  // (GET /tasks/relationships?type=parent-child). The Worker has no dedicated
  // tree endpoint; these are the two routes the DO/worker already expose.
  async tree(_rootId?: string): Promise<EntityTree> {
    const listResult = await this.client.get(
      `/projects/${this.projectId}/tasks`,
      {
        schema: PaginatedCompactEntityListResponseSchema,
        validate: true,
        query: { compact: "true" },
      },
    );
    const relResult = await this.client.get(
      `/projects/${this.projectId}/tasks/relationships`,
      {
        schema: ListEntityRelationshipsResponseSchema,
        validate: true,
        query: { type: "parent-child" },
      },
    );
    return { nodes: listResult.entities, edges: relResult.relationships };
  }

  // PATCH /projects/:projectId/tasks/:id with a caller-supplied fence.
  // Unlike update() (which auto-acquires), the caller owns the fence here, so a
  // stale fence surfaces the Worker's fence-conflict error verbatim.
  async updateWithFence(
    id: string,
    data: Partial<Entity["data"]>,
    fence: number,
  ): Promise<Entity> {
    const result = await this.client.patch(
      `/projects/${this.projectId}/tasks/${encodeURIComponent(id)}`,
      { data, fence },
      { schema: EntityResponseSchema, validate: true },
    );
    return result.entity;
  }

  // POST /projects/:projectId/tasks/:entityId/artifact-refs (worker entities.ts ~264)
  async addArtifactRef(input: AddArtifactRefInput): Promise<void> {
    const body: Record<string, unknown> = {
      artifact_key: input.artifact_key,
      slot: input.slot,
    };
    if (input.metadata !== undefined) body.metadata = input.metadata;
    await this.client.post(
      `/projects/${this.projectId}/tasks/${encodeURIComponent(input.entity_id)}/artifact-refs`,
      body,
      { schema: OkSchema, validate: true },
    );
  }

  // GET /projects/:projectId/tasks/:entityId/artifact-refs (worker entities.ts ~340)
  async listArtifactRefs(entityId: string): Promise<EntityArtifactReference[]> {
    const result = await this.client.get(
      `/projects/${this.projectId}/tasks/${encodeURIComponent(entityId)}/artifact-refs`,
      { schema: EntityArtifactReferenceListResponseSchema, validate: true },
    );
    return result.references;
  }

  // --- CoordinationBackend ---

  async acquire(
    resource: string,
    machine: string,
    user: string,
    mode: "exclusive" | "owner" | "presence",
    ttlMs: number,
  ): Promise<AcquireResult> {
    const result = await this.client.post(
      `/projects/${this.projectId}/claims/acquire`,
      { resource, mode, ttl_ms: ttlMs },
      { schema: AcquireSuccessResponseSchema, validate: true },
    );
    return {
      acquired: true,
      fence: result.fence,
      expires_at: result.expires_at,
    };
  }

  async renew(
    resource: string,
    _machine: string,
    _user: string,
    fence: number,
    ttlMs: number,
  ): Promise<RenewResult> {
    // The Worker returns 409 `renew-failed` (→ TilaApiError thrown by the HTTP
    // layer) on loss-of-claim, so a resolved response always means renewed:true.
    // Return the REAL stored `expires_at` from the response, matching
    // EmbeddedProject (which returns coordinationOps' stored expiry).
    const result = await this.client.post(
      `/projects/${this.projectId}/claims/renew`,
      { resource, fence, ttl_ms: ttlMs },
      { schema: RenewSuccessResponseSchema, validate: true },
    );
    return { renewed: true, expires_at: result.expires_at };
  }

  async release(resource: string, fence: number): Promise<void> {
    await this.client.post(
      `/projects/${this.projectId}/claims/release`,
      { resource, fence },
      { schema: ReleaseSuccessResponseSchema, validate: true },
    );
  }

  async state(resource: string): Promise<Claim | null> {
    const result = await this.client.get(
      `/projects/${this.projectId}/claims/state/${encodeURIComponent(resource)}`,
      { schema: StateResponseSchema, validate: true },
    );
    return result.claim ?? null;
  }

  async heartbeat(
    machine: string,
    info?: Record<string, unknown>,
  ): Promise<void> {
    await this.client.post(
      `/projects/${this.projectId}/presence/heartbeat`,
      { machine, info: info ?? {} },
      { schema: PresenceHeartbeatSuccessResponseSchema, validate: true },
    );
  }

  async listPresence(): Promise<Presence[]> {
    const result = await this.client.get(
      `/projects/${this.projectId}/presence/all`,
      { schema: PresenceAllListResponseSchema, validate: true },
    );
    // Strip the `active` field — Presence type has only machine, last_seen, info.
    return result.machines.map(({ machine, last_seen, info }) => ({
      machine,
      last_seen,
      info,
    }));
  }

  async listClaims(): Promise<Claim[]> {
    const result = await this.client.get(`/projects/${this.projectId}/claims`, {
      schema: StateListInternalSchema,
      validate: true,
    });
    return result.claims.map((c) => ({
      resource: c.resource,
      machine: c.machine,
      user: c.user,
      mode: c.mode,
      fence: c.fence,
      acquired_at: c.acquired_at,
      expires_at: c.expires_at,
      metadata: (c.metadata ?? {}) as Record<string, unknown>,
    }));
  }

  // --- JournalBackend ---

  async listJournal(query: JournalQuery): Promise<JournalEvent[]> {
    const result = await this.client.get(
      `/projects/${this.projectId}/journal`,
      {
        schema: JournalResponseSchema,
        validate: true,
        query: {
          resource: query.resource,
          kind: query.kind,
          limit: query.limit !== undefined ? String(query.limit) : undefined,
        },
      },
    );
    return result.events.map((ev) => ({
      seq: ev.seq,
      t: ev.t,
      kind: ev.kind,
      resource: ev.resource,
      actor: ev.actor,
      fence: ev.fence,
    }));
  }

  // --- GateBackend ---

  async createGate(
    resource: string,
    awaitType: string,
    fence: number,
    timeoutAt?: number,
  ): Promise<GateRecord> {
    const body: Record<string, unknown> = {
      resource,
      await_type: awaitType,
      fence,
    };
    if (timeoutAt !== undefined) body.timeout_at = timeoutAt;
    const result = await this.client.post(
      `/projects/${this.projectId}/gates`,
      body,
      { schema: GateResponseSchema, validate: true },
    );
    return {
      id: result.gate.id,
      resource: result.gate.resource,
      await_type: result.gate.await_type,
      status: result.gate.status,
      fence: result.gate.fence,
      timeout_at: result.gate.timeout_at,
      resolved_at: result.gate.resolved_at,
      resolution: result.gate.resolution,
      created_at: result.gate.created_at,
      created_by: result.gate.created_by,
    };
  }

  async listGates(filter?: GateFilter): Promise<GateRecord[]> {
    const params = new URLSearchParams();
    if (filter?.resource) params.set("resource", filter.resource);
    if (filter?.status) params.set("status", filter.status);
    const qs = params.toString();
    const url = `/projects/${this.projectId}/gates${qs ? `?${qs}` : ""}`;
    const result = await this.client.get(url, {
      schema: GateListResponseSchema,
      validate: true,
    });
    return result.gates.map((g) => ({
      id: g.id,
      resource: g.resource,
      await_type: g.await_type,
      status: g.status,
      fence: g.fence,
      timeout_at: g.timeout_at,
      resolved_at: g.resolved_at,
      resolution: g.resolution,
      created_at: g.created_at,
      created_by: g.created_by,
    }));
  }

  async resolveGate(gateId: string, resolution?: string): Promise<void> {
    const body: Record<string, unknown> = {};
    if (resolution) body.resolution = resolution;
    await this.client.post(
      `/projects/${this.projectId}/gates/${gateId}/resolve`,
      body,
      { schema: OkSchema, validate: true },
    );
  }

  async cancelGate(gateId: string): Promise<void> {
    await this.client.delete(`/projects/${this.projectId}/gates/${gateId}`, {
      schema: OkSchema,
      validate: true,
    });
  }

  // --- SignalBackend ---

  async sendSignal(
    input: SendSignalInput,
    _createdBy: string,
  ): Promise<{ id: string }> {
    const body: Record<string, unknown> = {
      target: input.target,
      kind: input.kind,
    };
    if (input.resource) body.resource = input.resource;
    if (input.payload !== undefined) body.payload = input.payload;
    if (input.ttl_ms !== undefined) body.ttl_ms = input.ttl_ms;
    const result = await this.client.post(
      `/projects/${this.projectId}/signals/send`,
      body,
      { schema: SendSignalResponseSchema, validate: true },
    );
    return { id: result.id };
  }

  async listSignals(_tokenName: string): Promise<SignalRecord[]> {
    const result = await this.client.get(
      `/projects/${this.projectId}/signals`,
      { schema: InboxResponseSchema, validate: true },
    );
    return result.signals.map((s) => ({
      id: s.id,
      target: s.target,
      kind: s.kind,
      resource: s.resource ?? null,
      payload: s.payload,
      created_by: s.created_by,
      created_at: s.created_at,
      expires_at: s.expires_at,
      acked_at: s.acked_at,
    }));
  }

  async ackSignal(signalId: string): Promise<{ found: boolean }> {
    await this.client.post(
      `/projects/${this.projectId}/signals/${signalId}/ack`,
      {},
      { schema: AckSignalResponseSchema, validate: true },
    );
    return { found: true };
  }

  // --- SchemaBackend ---

  async getCurrentSchema(): Promise<SchemaRecord> {
    const result = await this.client.get(`/projects/${this.projectId}/schema`, {
      schema: SchemaShowResponseSchema,
      validate: true,
    });
    return {
      version: result.version,
      definition: result.schema ? JSON.stringify(result.schema) : null,
    };
  }

  async applySchema(input: ApplySchemaInput): Promise<ApplySchemaOutput> {
    const body: Record<string, unknown> = {
      definition: input.definition,
    };
    if (input.strategy) body.strategy = input.strategy;
    const result = await this.client.post(
      `/projects/${this.projectId}/schema`,
      body,
      { schema: SchemaApplyLenientSchema, validate: true },
    );
    return {
      ok: true,
      version: result.version ?? null,
      changes: result.changes ?? [],
      noChange: result.noChange ?? false,
    };
  }

  // --- SummaryBackend ---

  async getSummary(): Promise<ProjectSummary> {
    const result = await this.client.get(
      `/projects/${this.projectId}/summary`,
      { schema: SummaryResponseSchema, validate: true },
    );
    return result.project;
  }
}

/**
 * RemoteArtifactBackend implements ArtifactBackend separately from RemoteBackend
 * because EntityBackend and ArtifactBackend both declare `get` and `list` with
 * incompatible return types. A single class cannot implement both interfaces.
 *
 * Both classes are constructed in resolveContext() and wired into their
 * respective CommandContext slots independently.
 */
export class RemoteArtifactBackend implements ArtifactBackend {
  constructor(
    private client: TilaClient,
    private projectId: string,
  ) {}

  // --- ArtifactBackend ---

  async put(
    options: ArtifactPutOptions,
  ): Promise<{ key: string; bytes: number }> {
    // Convert body to Blob for FormData
    let bodyBlob: Blob;
    if (typeof options.body === "string") {
      bodyBlob = new Blob([options.body], { type: options.contentType });
    } else if (options.body instanceof ArrayBuffer) {
      bodyBlob = new Blob([options.body], { type: options.contentType });
    } else {
      // ReadableStream -- buffer into ArrayBuffer first
      const arrayBuf = await new Response(options.body).arrayBuffer();
      bodyBlob = new Blob([arrayBuf], { type: options.contentType });
    }

    const formData = new FormData();
    formData.append("file", bodyBlob, options.key.split("/").pop() ?? "file");
    if (options.kind) formData.append("kind", options.kind);
    if (options.resource) formData.append("resource", options.resource);
    if (options.fence !== undefined)
      formData.append("fence", String(options.fence));
    if (options.flavor) formData.append("flavor", options.flavor);

    const result = await this.client.postFormData(
      `/projects/${this.projectId}/artifacts`,
      formData,
      { schema: ArtifactPutResponseSchema, validate: true },
    );
    return { key: result.key, bytes: result.bytes };
  }

  async get(key: string): Promise<{
    body: ReadableStream;
    contentType: string;
    metadata: Record<string, string>;
  } | null> {
    let response: Response;
    try {
      response = await this.client.requestRaw(
        "GET",
        `/projects/${this.projectId}/artifacts/${encodeURIComponent(key)}`,
      );
    } catch (err) {
      if (err instanceof TilaApiError && err.status === 404) {
        return null;
      }
      throw err;
    }
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new TilaApiError(
        response.status,
        "artifact-get-failed",
        `GET artifact ${key} failed: ${response.statusText}`,
        false,
      );
    }
    return {
      body: response.body as ReadableStream,
      contentType:
        response.headers.get("Content-Type") ?? "application/octet-stream",
      metadata: {},
    };
  }

  async list(prefix: string): Promise<{ key: string; size: number }[]> {
    // Uses the project-scoped artifacts endpoint with resource query param.
    // Inline schema because the exact response shape is defined locally in
    // commands/artifact.ts, not exported from @tila/schemas.
    const result = await this.client.get(
      `/projects/${this.projectId}/artifacts`,
      {
        schema: ArtifactListInternalSchema,
        validate: true,
        query: { resource: prefix },
      },
    );
    return result.pointers.map((p) => ({
      key: p.r2_key,
      size: p.bytes,
    }));
  }

  async delete(key: string): Promise<void> {
    await this.client.delete(
      `/projects/${this.projectId}/artifacts/${encodeURIComponent(key)}`,
      {
        schema: OkSchema,
        validate: true,
      },
    );
  }

  async listPointers(query: {
    resource?: string;
    kind?: string;
  }): Promise<ArtifactPointerRecord[]> {
    const q: Record<string, string | undefined> = {};
    if (query.resource) q.resource = query.resource;
    if (query.kind) q.kind = query.kind;
    const result = await this.client.get(
      `/projects/${this.projectId}/artifacts`,
      {
        schema: ArtifactListInternalSchema,
        validate: true,
        query: q,
      },
    );
    // `ArtifactListInternalSchema` now validates all ten ArtifactPointerRecord
    // fields, so this is a checked narrowing (the passthrough adds an index
    // signature, hence the plain `as`), not an unchecked `as unknown as`.
    return result.pointers as ArtifactPointerRecord[];
  }

  async addRelationship(
    fromKey: string,
    toKeyOrUri: { to_key?: string; to_uri?: string },
    type: string,
  ): Promise<void> {
    const body: Record<string, unknown> = {
      from_key: fromKey,
      type,
    };
    if (toKeyOrUri.to_key) body.to_key = toKeyOrUri.to_key;
    if (toKeyOrUri.to_uri) body.to_uri = toKeyOrUri.to_uri;
    await this.client.post(
      `/projects/${this.projectId}/artifacts/relationship`,
      body,
      { schema: OkSchema, validate: true },
    );
  }

  async listRelationships(key: string): Promise<ArtifactRelationship[]> {
    const result = await this.client.get(
      `/projects/${this.projectId}/artifacts/${encodeURIComponent(key)}/relationships`,
      { schema: RelListResponseSchema, validate: true },
    );
    return result.relationships;
  }

  async searchArtifacts(query: {
    q: string;
    kind?: string;
    resource?: string;
    limit?: number;
  }): Promise<ArtifactSearchResultRecord[]> {
    const q: Record<string, string | undefined> = {
      q: query.q,
    };
    if (query.kind) q.kind = query.kind;
    if (query.resource) q.resource = query.resource;
    if (query.limit !== undefined) q.limit = String(query.limit);
    const result = await this.client.get(
      `/projects/${this.projectId}/artifacts/search`,
      { schema: ArtifactSearchResponseSchema, validate: true, query: q },
    );
    return result.results;
  }

  async grepArtifacts(query: {
    pattern: string;
    kind?: string;
    resource?: string;
    regex?: boolean;
    limit?: number;
  }): Promise<ArtifactGrepResponse> {
    // Build query field-by-field (intentional non-spread):
    // - regex must serialize to "true" or be omitted (never "false")
    // - limit must be a string
    const q: Record<string, string> = { pattern: query.pattern };
    if (query.kind) q.kind = query.kind;
    if (query.resource) q.resource = query.resource;
    if (query.regex) q.regex = "true";
    if (query.limit != null) q.limit = String(query.limit);
    const result = await this.client.get(
      `/projects/${this.projectId}/artifacts/grep`,
      { schema: ArtifactGrepResponseSchema, validate: true, query: q },
    );
    return result;
  }

  async listIndexEntries(indexKey: string): Promise<ArtifactIndexEntry[]> {
    const result = await this.client.get(
      `/projects/${this.projectId}/artifacts/index/entries`,
      {
        schema: IndexEntriesResponseSchema,
        validate: true,
        query: { index_key: indexKey },
      },
    );
    return result.entries;
  }

  async getLatest(
    kind: string,
    resource: string,
  ): Promise<ArtifactPointerRecord | null> {
    let response: Response;
    try {
      response = await this.client.requestRaw(
        "GET",
        `/projects/${this.projectId}/artifacts/latest`,
        { query: { kind, resource } },
      );
    } catch (err) {
      if (err instanceof TilaApiError && err.status === 404) {
        return null;
      }
      throw err;
    }
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new TilaApiError(
        response.status,
        "artifact-get-latest-failed",
        `GET artifact latest failed: ${response.statusText}`,
        false,
      );
    }
    const body = (await response.json()) as {
      ok: true;
      pointer: ArtifactPointerRecord;
    };
    return body.pointer;
  }

  async writeText(
    content: string,
    opts: {
      kind: string;
      mimeType?: string;
      resource?: string;
      fence?: number;
    },
  ): Promise<{ key: string; bytes: number }> {
    const result = await this.client.post(
      `/projects/${this.projectId}/artifacts/text`,
      {
        content,
        kind: opts.kind,
        mime_type: opts.mimeType ?? "text/markdown",
        resource: opts.resource,
        fence: opts.fence,
      },
      { schema: ArtifactPutResponseSchema, validate: true },
    );
    return { key: result.key, bytes: result.bytes };
  }

  async readText(
    key: string,
  ): Promise<{ content: string; mimeType: string } | null> {
    let response: Response;
    try {
      response = await this.client.requestRaw(
        "GET",
        `/projects/${this.projectId}/artifacts/${encodeURIComponent(key)}`,
      );
    } catch (err) {
      if (err instanceof TilaApiError && err.status === 404) {
        return null;
      }
      throw err;
    }
    if (response.status === 404) return null;
    const contentType =
      response.headers.get("content-type") || "application/octet-stream";
    if (!contentType.startsWith("text/")) {
      throw new TypeError(
        `Artifact ${key} has MIME type ${contentType} — readText only supports text/* artifacts`,
      );
    }
    const text = await response.text();
    return { content: text, mimeType: contentType };
  }
}

/**
 * RemoteRecordBackend implements RecordBackend over the Worker record HTTP
 * routes (see `packages/worker/src/routes/records.ts`). Paths mirror the SDK
 * record methods (`packages/sdk/src/records.ts`) so the two stay in lockstep.
 *
 * Wire ↔ RecordRow mapping: the mutate/get responses return a `record`
 * (`RecordItem`, no fence) plus a top-level `fence`. RecordBackend returns
 * `RecordRow`, which is `RecordItem` extended with `fence`, so each method
 * merges the two: `{ ...result.record, fence: result.fence }`.
 *
 * Like the SDK, multi-segment keys are encoded segment-by-segment so embedded
 * slashes survive routing (the Worker matches `:key{.+}`).
 */
export class RemoteRecordBackend implements RecordBackend {
  constructor(
    private client: TilaClient,
    private projectId: string,
  ) {}

  private base(): string {
    return `/projects/${this.projectId}/records`;
  }

  /** Encode a record key per-segment so embedded `/` separators are preserved. */
  private encodeKey(key: string): string {
    return key.split("/").map(encodeURIComponent).join("/");
  }

  async createRecord(input: CreateRecordInput): Promise<RecordRow> {
    const body: Record<string, unknown> = {
      key: input.key,
      value: input.value,
    };
    if (input.tags) body.tags = input.tags;
    if (input.message != null) body.message = input.message;
    if (input.sourceArtifactKey != null)
      body.source_artifact_key = input.sourceArtifactKey;
    const result = await this.client.post(
      `${this.base()}/${input.type}`,
      body,
      { schema: RecordMutateResponseSchema, validate: true },
    );
    return { ...result.record, fence: result.fence };
  }

  async setRecord(input: SetRecordInput): Promise<RecordRow> {
    const body: Record<string, unknown> = {
      value: input.value,
      fence: input.fence,
    };
    if (input.tags) body.tags = input.tags;
    if (input.message != null) body.message = input.message;
    if (input.sourceArtifactKey != null)
      body.source_artifact_key = input.sourceArtifactKey;
    const result = await this.client.put(
      `${this.base()}/${input.type}/${this.encodeKey(input.key)}`,
      body,
      { schema: RecordMutateResponseSchema, validate: true },
    );
    return { ...result.record, fence: result.fence };
  }

  async getRecord(type: string, key: string): Promise<RecordRow | null> {
    try {
      const result = await this.client.get(
        `${this.base()}/${type}/${this.encodeKey(key)}`,
        { schema: RecordGetResponseSchema, validate: true },
      );
      return { ...result.record, fence: result.fence };
    } catch (err) {
      if (err instanceof TilaApiError && err.status === 404) {
        return null;
      }
      throw err;
    }
  }

  async patchRecord(input: PatchRecordInput): Promise<RecordRow> {
    const body: Record<string, unknown> = {
      patch: input.patch,
      fence: input.fence,
    };
    if (input.message != null) body.message = input.message;
    const result = await this.client.patch(
      `${this.base()}/${input.type}/${this.encodeKey(input.key)}`,
      body,
      { schema: RecordMutateResponseSchema, validate: true },
    );
    return { ...result.record, fence: result.fence };
  }

  async archiveRecord(input: ArchiveRecordInput): Promise<RecordRow> {
    const body: Record<string, unknown> = { fence: input.fence };
    if (input.message != null) body.message = input.message;
    const result = await this.client.post(
      `${this.base()}/${input.type}/~/archive/${this.encodeKey(input.key)}`,
      body,
      { schema: RecordMutateResponseSchema, validate: true },
    );
    return { ...result.record, fence: result.fence };
  }

  async unarchiveRecord(input: ArchiveRecordInput): Promise<RecordRow> {
    const body: Record<string, unknown> = { fence: input.fence };
    if (input.message != null) body.message = input.message;
    const result = await this.client.post(
      `${this.base()}/${input.type}/~/unarchive/${this.encodeKey(input.key)}`,
      body,
      { schema: RecordMutateResponseSchema, validate: true },
    );
    return { ...result.record, fence: result.fence };
  }

  async listRecords(
    filter: RecordListFilter,
  ): Promise<RecordPage<RecordListItem>> {
    const query: Record<string, string | undefined> = {};
    if (filter.tag) query.tag = filter.tag;
    if (filter.includeArchived) query["include-archived"] = "true";
    if (filter.tagFilter?.length) query.tag_filter = filter.tagFilter.join(",");
    if (filter.dataFilter) query.filter = JSON.stringify(filter.dataFilter);
    if (filter.limit !== undefined) query.limit = String(filter.limit);
    const result = await this.client.get(`${this.base()}/${filter.type}`, {
      schema: RecordListResponseSchema,
      validate: true,
      query,
    });
    return {
      items: result.items,
      total: result.meta.total,
      next_cursor: result.meta.next_cursor,
    };
  }

  async listRecordHistory(
    type: string,
    key: string,
    opts?: RecordHistoryOptions,
  ): Promise<RecordPage<RecordHistoryItem>> {
    const query: Record<string, string | undefined> = {};
    if (opts?.limit !== undefined) query.limit = String(opts.limit);
    if (opts?.includeValues !== undefined)
      query.values = String(opts.includeValues);
    const result = await this.client.get(
      `${this.base()}/${type}/~/history/${this.encodeKey(key)}`,
      { schema: RecordHistoryResponseSchema, validate: true, query },
    );
    return {
      items: result.items,
      total: result.meta.total,
      next_cursor: result.meta.next_cursor,
    };
  }

  async listRecordTypesInUse(): Promise<string[]> {
    const result = await this.client.get(`${this.base()}/_types`, {
      schema: RecordTypesInternalSchema,
      validate: true,
    });
    return result.in_use_types ?? [];
  }
}
