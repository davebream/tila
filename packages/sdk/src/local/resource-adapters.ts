/**
 * Local resource adapters — present the SAME public method surface the HTTP
 * resource-method factories expose (`createTaskMethods`, `createRecordMethods`,
 * `createClaimMethods`, `createArtifactMethods`, …), but backed by the embedded
 * `EmbeddedProject` / `EmbeddedArtifactBackend` (better-sqlite3 + node:fs)
 * instead of `TilaClient` HTTP calls.
 *
 * ## Why this is an ADAPTER, not a parameter-widen (critic fix R12)
 *
 * The HTTP factories expose HTTP-shaped names + signatures — e.g.
 * `records.create(type, req)` POSTs a request body, returning a
 * `RecordMutateResponse` envelope (`{ ok, record, fence, revision }`). The
 * `@tila/core` `RecordBackend` shape is different: `createRecord(input)` takes
 * a single camelCase input object and returns a bare `RecordRow` (the row plus
 * a `fence`, no `ok`/`revision` envelope). These do not line up by widening a
 * `client` parameter — each method must be translated:
 *
 *   factory:  records.create(type, { key, value, tags })  -> RecordMutateResponse
 *   backend:  createRecord({ type, key, value, tags })     -> RecordRow
 *   adapter:  unpack the (type, req) args into the camelCase input, call
 *             createRecord, then re-wrap the RecordRow into the HTTP envelope.
 *
 * Each adapter below does exactly that name+arg+return-shape translation, so a
 * consumer can swap `createTila({backend:"local"})` for
 * `createTila({backend:"cloudflare"})` without changing any call site.
 *
 * HTTP-only resources (token issuance — a D1 global-store concern with no local
 * equivalent) throw `LocalUnsupportedError` rather than silently no-op.
 */
import type {
  EmbeddedArtifactBackend,
  EmbeddedProject,
} from "@tila/backend-embedded";
import type {
  AckSignalResponse,
  AcquireSuccessResponse,
  ArchiveSuccessResponse,
  ArtifactGrepResponse,
  ArtifactListResponse,
  ArtifactPointer,
  ArtifactPutResponse,
  ArtifactSearchResponse,
  ClaimMode,
  CreateEntityRelationshipResponse,
  CreateGateRequest,
  EntityArtifactReferenceListResponse,
  EntityDetailResponse,
  EntityListResponse,
  EntityResponse,
  GateListResponse,
  GateResponse,
  InboxResponse,
  InstantiateTemplateRequest,
  InstantiateTemplateResponse,
  JournalResponse,
  PresenceAllListResponse,
  PresenceHeartbeatSuccessResponse,
  PresenceListResponse,
  RecordArchiveRequest,
  RecordCreateRequest,
  RecordGetResponse,
  RecordHistoryResponse,
  RecordListResponse,
  RecordMutateResponse,
  RecordPatchRequest,
  RecordRow,
  RecordSetRequest,
  RecordTypesResponse,
  RecordUnarchiveRequest,
  ReleaseSuccessResponse,
  RenewSuccessResponse,
  SendSignalRequest,
  SendSignalResponse,
  StateListResponse,
  StateResponse,
  SummaryResponse,
  UnifiedSearchResponse,
} from "@tila/schemas";

/**
 * Thrown when a consumer calls a facade method that has no local equivalent
 * (token issuance, which is a D1 global-store / Worker-auth concern).
 */
export class LocalUnsupportedError extends Error {
  constructor(method: string) {
    super(
      `${method} is not available in local mode (backend = "local"). It requires the Cloudflare backend (D1 token store). Use createTila({ backend: "cloudflare" }) for token issuance.`,
    );
    this.name = "LocalUnsupportedError";
  }
}

/** Strip the `fence` to expose the HTTP wire `record` (RecordItem) shape. */
function toRecordMutateResponse(row: RecordRow): RecordMutateResponse {
  const { fence, ...record } = row;
  return { ok: true, record, fence, revision: row.revision };
}

function toRecordGetResponse(row: RecordRow): RecordGetResponse {
  const { fence, ...record } = row;
  return { ok: true, record, fence };
}

/**
 * Task methods (mirrors `createTaskMethods` / `_createMethods` in `entities.ts`).
 * HTTP-shaped `create(id, type, data?, tags?)` -> EntityBackend `create(input)`.
 */
function createLocalTaskMethods(project: EmbeddedProject) {
  return {
    async create(
      id: string,
      type: string,
      data?: Record<string, unknown>,
      _tags?: string[],
    ): Promise<EntityResponse> {
      const entity = await project.create({
        id,
        type,
        data: data ?? {},
        created_by: "local",
      });
      return { ok: true, entity };
    },

    async get(id: string): Promise<EntityDetailResponse> {
      const entity = await project.get(id);
      if (!entity) throw new Error(`Task not found: ${id}`);
      const relationships = await project.listRelationships({ from_id: id });
      return { ok: true, entity, relationships };
    },

    async list(query?: {
      type?: string;
      status?: string;
      limit?: string;
      cursor?: string;
      tagFilter?: string[];
    }): Promise<EntityListResponse> {
      // `EntityListFilter` (the embedded `list` shape) has no tag-filter field,
      // so `query.tagFilter` is intentionally not threaded here — it is a no-op
      // locally (parity-limited; the HTTP backend supports it).
      const entities = await project.list({
        type: query?.type,
        archived: 0,
        limit: query?.limit ? Number(query.limit) : undefined,
        dataFilter: query?.status ? { status: query.status } : undefined,
      });
      return { ok: true, entities };
    },

    async update(
      id: string,
      data: Record<string, unknown>,
      fence: number,
    ): Promise<EntityResponse> {
      const entity = await project.updateWithFence(id, data, fence);
      return { ok: true, entity };
    },

    async archive(id: string, _fence: number): Promise<ArchiveSuccessResponse> {
      await project.archive(id);
      return { ok: true };
    },

    async addRelationship(
      fromId: string,
      toId: string,
      type: string,
    ): Promise<CreateEntityRelationshipResponse> {
      const { created } = await project.addRelationship({
        from_id: fromId,
        to_id: toId,
        type,
      });
      return { ok: true, created };
    },

    async addArtifactRef(
      entityId: string,
      artifactKey: string,
      slot: string,
      metadata?: Record<string, unknown>,
    ): Promise<{ ok: true }> {
      await project.addArtifactRef({
        entity_id: entityId,
        artifact_key: artifactKey,
        slot,
        metadata,
      });
      return { ok: true };
    },

    async listArtifactRefs(
      entityId: string,
    ): Promise<EntityArtifactReferenceListResponse> {
      const references = await project.listArtifactRefs(entityId);
      return { ok: true, references };
    },
  };
}

/**
 * Record methods (mirrors `createRecordMethods` in `records.ts`).
 * HTTP-shaped `create(type, req)` -> RecordBackend `createRecord(input)`,
 * re-wrapping the bare RecordRow into the HTTP envelope.
 */
function createLocalRecordMethods(project: EmbeddedProject) {
  return {
    async create(
      type: string,
      req: RecordCreateRequest,
    ): Promise<RecordMutateResponse> {
      const row = await project.createRecord({
        type,
        key: req.key,
        value: req.value,
        tags: req.tags,
        message: req.message ?? null,
        sourceArtifactKey: req.source_artifact_key ?? null,
      });
      return toRecordMutateResponse(row);
    },

    async set(
      type: string,
      key: string,
      req: RecordSetRequest,
    ): Promise<RecordMutateResponse> {
      const row = await project.setRecord({
        type,
        key,
        value: req.value,
        fence: req.fence,
        tags: req.tags,
        message: req.message ?? null,
        sourceArtifactKey: req.source_artifact_key ?? null,
      });
      return toRecordMutateResponse(row);
    },

    async get(type: string, key: string): Promise<RecordGetResponse> {
      const row = await project.getRecord(type, key);
      if (!row) throw new Error(`Record not found: ${type}/${key}`);
      return toRecordGetResponse(row);
    },

    async patch(
      type: string,
      key: string,
      req: RecordPatchRequest,
    ): Promise<RecordMutateResponse> {
      const row = await project.patchRecord({
        type,
        key,
        patch: req.patch,
        fence: req.fence,
        message: req.message ?? null,
      });
      return toRecordMutateResponse(row);
    },

    async archive(
      type: string,
      key: string,
      req: RecordArchiveRequest,
    ): Promise<RecordMutateResponse> {
      const row = await project.archiveRecord({
        type,
        key,
        fence: req.fence,
        message: req.message ?? null,
      });
      return toRecordMutateResponse(row);
    },

    async unarchive(
      type: string,
      key: string,
      req: RecordUnarchiveRequest,
    ): Promise<RecordMutateResponse> {
      const row = await project.unarchiveRecord({
        type,
        key,
        fence: req.fence,
        message: req.message ?? null,
      });
      return toRecordMutateResponse(row);
    },

    async history(
      type: string,
      key: string,
      opts?: { limit?: number; values?: boolean },
    ): Promise<RecordHistoryResponse> {
      const page = await project.listRecordHistory(type, key, {
        limit: opts?.limit,
        includeValues: opts?.values,
      });
      return {
        ok: true,
        items: page.items,
        meta: {
          total: page.total,
          limit: opts?.limit ?? page.items.length,
          next_cursor: page.next_cursor,
        },
      };
    },

    async list(
      type: string,
      query?: {
        tag?: string;
        filter?: string;
        "include-archived"?: string;
        limit?: string;
        tagFilter?: string[];
      },
    ): Promise<RecordListResponse> {
      const page = await project.listRecords({
        type,
        tag: query?.tag,
        includeArchived: query?.["include-archived"] === "true",
        tagFilter: query?.tagFilter,
        dataFilter: query?.filter ? JSON.parse(query.filter) : undefined,
        limit: query?.limit ? Number(query.limit) : undefined,
      });
      return {
        ok: true,
        items: page.items,
        meta: {
          total: page.total,
          limit: query?.limit ? Number(query.limit) : page.items.length,
          next_cursor: page.next_cursor,
        },
      };
    },

    async types(): Promise<RecordTypesResponse> {
      const types = await project.listRecordTypesInUse();
      return { ok: true, types };
    },

    async typesInUse(): Promise<RecordTypesResponse> {
      const types = await project.listRecordTypesInUse();
      return { ok: true, types };
    },
  };
}

/**
 * Claim methods (mirrors `createClaimMethods` in `claims.ts`).
 * HTTP-shaped `acquire(resource, mode, ttlMs, opts?)` -> CoordinationBackend
 * `acquire(resource, machine, user, mode, ttlMs)`.
 */
function createLocalClaimMethods(project: EmbeddedProject) {
  return {
    async acquire(
      resource: string,
      mode: ClaimMode,
      ttlMs: number,
      _opts?: { metadata?: Record<string, unknown>; idempotency_key?: string },
    ): Promise<AcquireSuccessResponse> {
      const result = await project.acquire(
        resource,
        "local",
        "local",
        mode,
        ttlMs,
      );
      return { ok: true, fence: result.fence, expires_at: result.expires_at };
    },

    async renew(
      resource: string,
      fence: number,
      ttlMs: number,
    ): Promise<RenewSuccessResponse> {
      await project.renew(resource, "local", "local", fence, ttlMs);
      return { ok: true, expires_at: Date.now() + ttlMs };
    },

    async release(
      resource: string,
      fence: number,
    ): Promise<ReleaseSuccessResponse> {
      await project.release(resource, fence);
      return { ok: true };
    },

    async list(): Promise<StateListResponse> {
      const claims = await project.listClaims();
      return { ok: true, claims };
    },

    async get(resource: string): Promise<StateResponse> {
      const claim = await project.state(resource);
      return { ok: true, claim };
    },
  };
}

/**
 * Artifact methods (mirrors `createArtifactMethods` in `artifacts.ts`).
 * `upload`/`download` (multipart/stream HTTP forms) are not part of the local
 * adapter surface — local consumers use `writeText`/`readText`, the
 * content-addressed primitives the embedded backend exposes. `upload`/`download`
 * throw `LocalUnsupportedError` so call sites fail loudly rather than silently
 * missing.
 */
function createLocalArtifactMethods(artifacts: EmbeddedArtifactBackend) {
  return {
    upload(): never {
      throw new LocalUnsupportedError("artifacts.upload");
    },

    download(): never {
      throw new LocalUnsupportedError("artifacts.download");
    },

    async writeText(
      content: string,
      opts: {
        kind: string;
        mimeType?: string;
        resource?: string;
        fence?: number;
      },
    ): Promise<ArtifactPutResponse> {
      const { key, bytes } = await artifacts.writeText(content, opts);
      // The embedded backend's put is INSERT-OR-IGNORE on the content-addressed
      // key, so it does not surface a dedup flag; report false (the response
      // contract requires the field).
      return { ok: true, key, bytes, deduplicated: false };
    },

    async readText(
      key: string,
    ): Promise<{ content: string; mimeType: string }> {
      const result = await artifacts.readText(key);
      if (!result) throw new Error(`Artifact not found: ${key}`);
      return result;
    },

    async list(query?: {
      resource?: string;
      kind?: string;
      limit?: string;
      tagFilter?: string[];
    }): Promise<ArtifactListResponse> {
      const pointers = await artifacts.listPointers({
        resource: query?.resource,
        kind: query?.kind,
      });
      return { ok: true, pointers } as ArtifactListResponse;
    },

    async search(
      q: string,
      opts?: { kind?: string; resource?: string; limit?: string },
    ): Promise<ArtifactSearchResponse> {
      const results = await artifacts.searchArtifacts({
        q,
        kind: opts?.kind,
        resource: opts?.resource,
        limit: opts?.limit ? Number(opts.limit) : undefined,
      });
      return { ok: true, results } as ArtifactSearchResponse;
    },

    async grep(
      pattern: string,
      opts?: {
        kind?: string;
        resource?: string;
        regex?: boolean;
        limit?: number;
      },
    ): Promise<ArtifactGrepResponse> {
      return artifacts.grepArtifacts({ pattern, ...opts });
    },

    async getLatest(
      kind: string,
      resource: string,
    ): Promise<ArtifactPointer | null> {
      return (await artifacts.getLatest(
        kind,
        resource,
      )) as ArtifactPointer | null;
    },
  };
}

/** Gate methods (mirrors `createGateMethods` in `gates.ts`). */
function createLocalGateMethods(project: EmbeddedProject) {
  return {
    async list(query?: {
      resource?: string;
      status?: string;
      limit?: string;
    }): Promise<GateListResponse> {
      const gates = await project.listGates({
        resource: query?.resource,
        status: query?.status as never,
      });
      return { ok: true, gates } as GateListResponse;
    },

    async create(req: CreateGateRequest): Promise<GateResponse> {
      const gate = await project.createGate(
        req.resource,
        req.await_type,
        req.fence,
        req.timeout_at,
      );
      return { ok: true, gate } as GateResponse;
    },

    async resolve(
      gateId: string,
      req?: { resolution?: string },
    ): Promise<GateResponse> {
      await project.resolveGate(gateId, req?.resolution);
      const gates = await project.listGates();
      const gate = gates.find((g) => g.id === gateId);
      if (!gate) throw new Error(`Gate not found: ${gateId}`);
      return { ok: true, gate } as GateResponse;
    },

    async remove(gateId: string): Promise<{ ok: true }> {
      await project.cancelGate(gateId);
      return { ok: true };
    },
  };
}

/** Signal methods (mirrors `createSignalMethods` in `signals.ts`). */
function createLocalSignalMethods(project: EmbeddedProject) {
  return {
    async inbox(): Promise<InboxResponse> {
      const signals = await project.listSignals("local");
      return { ok: true, signals } as InboxResponse;
    },

    async send(req: SendSignalRequest): Promise<SendSignalResponse> {
      const { id } = await project.sendSignal(
        {
          target: req.target,
          kind: req.kind,
          resource: req.resource,
          payload: req.payload,
          ttl_ms: req.ttl_ms,
        },
        "local",
      );
      return { ok: true, id };
    },

    async ack(signalId: string): Promise<AckSignalResponse> {
      const { found } = await project.ackSignal(signalId);
      return { ok: true, found } as AckSignalResponse;
    },
  };
}

/** Journal methods (mirrors `createJournalMethods` in `journal.ts`). */
function createLocalJournalMethods(project: EmbeddedProject) {
  return {
    async query(opts?: {
      entity_id?: string;
      event_kind?: string;
      limit?: string;
      cursor?: string;
    }): Promise<JournalResponse> {
      const events = await project.listJournal({
        resource: opts?.entity_id,
        kind: opts?.event_kind,
        limit: opts?.limit ? Number(opts.limit) : undefined,
      });
      return { ok: true, events } as unknown as JournalResponse;
    },
  };
}

/** Presence methods (mirrors `createPresenceMethods` in `presence.ts`). */
function createLocalPresenceMethods(project: EmbeddedProject) {
  return {
    async heartbeat(
      machine: string,
      _ttlMs?: number,
    ): Promise<PresenceHeartbeatSuccessResponse> {
      await project.heartbeat(machine);
      return { ok: true } as PresenceHeartbeatSuccessResponse;
    },

    async list(): Promise<PresenceListResponse> {
      const presence = await project.listPresence();
      return { ok: true, presence } as unknown as PresenceListResponse;
    },

    async listAll(): Promise<PresenceAllListResponse> {
      const presence = await project.listPresence();
      const machines = presence.map((p) => ({ ...p, active: true }));
      return { ok: true, machines } as unknown as PresenceAllListResponse;
    },
  };
}

/** Schema methods (mirrors `createSchemaMethods` in `schema.ts`). */
function createLocalSchemaMethods(project: EmbeddedProject) {
  return {
    async get(): Promise<{ ok: true; schema: unknown; version: number }> {
      const current = await project.getCurrentSchema();
      return {
        ok: true,
        schema: current.definition ? JSON.parse(current.definition) : null,
        version: current.version ?? 0,
      };
    },

    async apply(
      schema: unknown,
      strategy?: string,
    ): Promise<{ ok: true; version: number; diff: unknown }> {
      const result = await project.applySchema({
        definition:
          typeof schema === "string" ? schema : JSON.stringify(schema),
        strategy: strategy as never,
      });
      return { ok: true, version: result.version ?? 0, diff: result.changes };
    },

    async history(_opts?: { limit?: string }): Promise<{
      ok: true;
      entries: unknown[];
    }> {
      // No local schema-history listing op; the embedded backend keeps only the
      // current schema. Return an empty list rather than throwing.
      return { ok: true, entries: [] };
    },
  };
}

/** Summary methods (mirrors `createSummaryMethods` in `summary.ts`). */
function createLocalSummaryMethods(project: EmbeddedProject) {
  return {
    async get(): Promise<SummaryResponse> {
      const project_ = await project.getSummary();
      return { ok: true, project: project_ } as unknown as SummaryResponse;
    },
  };
}

/** Unified search (mirrors `createSearchMethods` in `search.ts`). */
function createLocalSearchMethods(project: EmbeddedProject) {
  return {
    async search(
      q: string,
      opts?: { limit?: number; tagFilter?: string[] },
    ): Promise<UnifiedSearchResponse> {
      const results = project.searchAll({
        q,
        limit: opts?.limit,
        tagFilter: opts?.tagFilter,
      });
      return { ok: true, results } as unknown as UnifiedSearchResponse;
    },
  };
}

/** Template methods (mirrors `createTemplateMethods` in `templates.ts`). */
function createLocalTemplateMethods(project: EmbeddedProject) {
  return {
    async instantiate(
      req: InstantiateTemplateRequest,
    ): Promise<InstantiateTemplateResponse> {
      const result = project.instantiateTemplate({
        template_name: req.template_name,
        root_id: req.root_id,
        vars: req.vars,
      });
      return {
        ok: true,
        created_entities: result.created_entities,
        created_relationships: result.created_relationships,
        journal_seq: result.journal_seq,
      } as unknown as InstantiateTemplateResponse;
    },

    async list(): Promise<{
      ok: true;
      templates: Array<{
        name: string;
        type: string;
        description: string | null;
        variables: string[];
      }>;
    }> {
      // Templates are declared in the applied schema; the embedded backend has
      // no list op, so derive from the current schema definition.
      const current = await project.getCurrentSchema();
      if (!current.definition) return { ok: true, templates: [] };
      const parsed = JSON.parse(current.definition) as {
        templates?: Record<
          string,
          { description?: string; entities?: Record<string, { type: string }> }
        >;
      };
      const templates = Object.entries(parsed.templates ?? {}).map(
        ([name, def]) => ({
          name,
          type: Object.values(def.entities ?? {})[0]?.type ?? "",
          description: def.description ?? null,
          variables: [],
        }),
      );
      return { ok: true, templates };
    },
  };
}

/**
 * Token methods — HTTP-only (D1 global store). Every method REJECTS locally
 * (async, mirroring the HTTP factory's Promise-returning signatures) so call
 * sites that `await tokens.issue(...)` get a clean rejection, not a synchronous
 * throw that bypasses their try/catch around the await.
 */
function createLocalTokenMethods() {
  return {
    async issue(): Promise<never> {
      throw new LocalUnsupportedError("tokens.issue");
    },
    async revoke(): Promise<never> {
      throw new LocalUnsupportedError("tokens.revoke");
    },
    async list(): Promise<never> {
      throw new LocalUnsupportedError("tokens.list");
    },
  };
}

/**
 * Build the full local resource-method surface from an `EmbeddedProject` +
 * `EmbeddedArtifactBackend`. The returned object's keys + method shapes mirror
 * the HTTP facade so `createTila`'s two branches are interchangeable.
 */
export function buildLocalResources(
  project: EmbeddedProject,
  artifacts: EmbeddedArtifactBackend,
) {
  return {
    tasks: createLocalTaskMethods(project),
    records: createLocalRecordMethods(project),
    claims: createLocalClaimMethods(project),
    artifacts: createLocalArtifactMethods(artifacts),
    gates: createLocalGateMethods(project),
    signals: createLocalSignalMethods(project),
    journal: createLocalJournalMethods(project),
    presence: createLocalPresenceMethods(project),
    schema: createLocalSchemaMethods(project),
    summary: createLocalSummaryMethods(project),
    search: createLocalSearchMethods(project),
    templates: createLocalTemplateMethods(project),
    tokens: createLocalTokenMethods(),
  };
}
