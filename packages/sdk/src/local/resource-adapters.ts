import type {
  EmbeddedArtifactBackend,
  EmbeddedProject,
} from "@tila/backend-embedded";
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
import { type GateRecord, parseTilaSchemaToml } from "@tila/core";
import type {
  AckSignalResponse,
  AcquireSuccessResponse,
  ArchiveSuccessResponse,
  ArtifactGrepResponse,
  ArtifactListResponse,
  ArtifactPointer,
  ArtifactPutResponse,
  ArtifactRelationshipListResponse,
  ArtifactRelationshipOkResponse,
  ArtifactSearchResponse,
  ClaimMode,
  CreateEntityRelationshipResponse,
  CreateGateRequest,
  EntityArtifactReferenceListResponse,
  EntityDetailResponse,
  EntityListResponse,
  EntityResponse,
  Gate,
  GateListResponse,
  GateResponse,
  InboxResponse,
  InstantiateTemplateRequest,
  InstantiateTemplateResponse,
  JournalResponse,
  ListEntityRelationshipsResponse,
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
  RecordPutRequest,
  RecordRow,
  RecordSetRequest,
  RecordTypesResponse,
  RecordUnarchiveRequest,
  ReleaseSuccessResponse,
  RenewSuccessResponse,
  SendSignalRequest,
  SendSignalResponse,
  Signal,
  StateListResponse,
  StateResponse,
  SummaryResponse,
  UnifiedSearchResponse,
} from "@tila/schemas";
import type { ArtifactUploadOpts } from "../artifacts";
import { TilaApiError, type TilaFacade } from "../client";

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
      tags?: string[],
    ): Promise<EntityResponse> {
      const entity = await project.create({
        id,
        type,
        data: data ?? {},
        created_by: "local",
        tags,
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
      // Local DIVERGENCE: `compact` is an HTTP-only projection (the Worker's
      // compact list). The embedded backend has no compact list, so this is
      // accepted (surface parity) but ignored — local always returns full
      // entities.
      compact?: boolean;
    }): Promise<EntityListResponse> {
      // DIVERGENCE (Task 14): `cursor` is accepted by the factory signature but
      // the wire `EntityListResponse` carries NO pagination meta (no
      // next_cursor/total) — unlike the wire `RecordListResponse`. So this
      // adapter cannot return a cursor without breaking the shared return shape;
      // `cursor` is a no-op here, matching the factory's non-paginated tasks.list
      // contract. (Lifting tasks.list to a paginated response is a wire-shape
      // change tracked for Task 14.)
      const entities = await project.list({
        type: query?.type,
        archived: 0,
        limit: query?.limit ? Number(query.limit) : undefined,
        dataFilter: query?.status ? { status: query.status } : undefined,
        tagFilter: query?.tagFilter,
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

    async listRelationships(filter?: {
      fromId?: string;
      toId?: string;
      type?: string;
    }): Promise<ListEntityRelationshipsResponse> {
      const relationships = await project.listRelationships({
        from_id: filter?.fromId,
        to_id: filter?.toId,
        type: filter?.type,
      });
      return { ok: true, relationships };
    },

    async ready(query?: {
      type?: string;
      parent?: string;
      limit?: number;
      includeSoftBlocked?: boolean;
    }): Promise<EntityListResponse> {
      const entities = await project.listReady({
        type: query?.type,
        parent: query?.parent,
        limit: query?.limit,
        includeSoftBlocked: query?.includeSoftBlocked,
      });
      return { ok: true, entities };
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

    async put(
      type: string,
      key: string,
      req: RecordPutRequest,
    ): Promise<RecordMutateResponse> {
      const row = await project.putRecord({
        type,
        key,
        value: req.value,
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
      // Local DIVERGENCE: `_opts.idempotency_key` is accepted (to keep the
      // surface aligned with the HTTP factory) but NOT honored locally — remote
      // dedups via D1, while local relies on primary-key-level dedup. The
      // embedded `_idempotency` table + EmbeddedProject.check/storeIdempotency
      // exist but are intentionally unwired here (single-machine-low-risk).
      // See docs/02-ARCHITECTURE.md §1.6a and the SDK README divergence list.
      const result = await project.acquire(
        resource,
        "local",
        "local",
        mode,
        ttlMs,
      );
      // coordinationOps returns {acquired:false} (no throw) on conflict; the DO
      // maps that to 409 `already-held` (coordination-routes.ts ~43-50). Match
      // it so isTilaApiError(err) branches identically across backends.
      if (!result.acquired) {
        throw new TilaApiError(
          409,
          "already-held",
          `Resource ${resource} already held`,
          false,
        );
      }
      return { ok: true, fence: result.fence, expires_at: result.expires_at };
    },

    async renew(
      resource: string,
      fence: number,
      ttlMs: number,
    ): Promise<RenewSuccessResponse> {
      const result = await project.renew(
        resource,
        "local",
        "local",
        fence,
        ttlMs,
      );
      // coordinationOps returns {renewed:false} (no throw) when the claim is
      // missing / expired / held by a different holder; the DO maps that to 409
      // `renew-failed` (coordination-routes.ts ~86-94). Without this guard, local
      // renew would silently report success after the caller LOST the claim —
      // breaking the fencing contract. Throw the SAME TilaApiError so
      // isTilaApiError(err)/err.status===409 work identically across backends.
      if (!result.renewed) {
        throw new TilaApiError(
          409,
          "renew-failed",
          "Claim not found, expired, or holder mismatch",
          false,
        );
      }
      // Return the REAL stored expiry, not a recomputed Date.now()+ttlMs.
      return { ok: true, expires_at: result.expires_at };
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
    // These stubs carry the SAME EXPLICIT parameter shape as the HTTP facade's
    // `upload`/`download` (the overloaded `upload` signature + the `download(key)`
    // signature, written out so they MUST line up with the facade). A zero-param
    // `(): never` would make `_assertLocalSurfaceMatchesFacade` pass VACUOUSLY for
    // these methods (TS's fewer-params-assignable rule), so spelling the params out
    // keeps the compile-time guard non-vacuous while the body still throws.
    upload(
      input: File | Blob | ReadableStream,
      _opts: ArtifactUploadOpts,
    ): never {
      void input;
      throw new LocalUnsupportedError("artifacts.upload");
    },

    download(_key: string): never {
      throw new LocalUnsupportedError("artifacts.download");
    },

    async writeText(
      content: string,
      opts: {
        kind: string;
        mimeType?: string;
        resource?: string;
        fence?: number;
        tags?: string[];
      },
    ): Promise<ArtifactPutResponse> {
      // Local DIVERGENCE (Task 14): the embedded artifact backend's writeText /
      // put / upsertPointer chain carries no `tags` column, so artifact tags are
      // not persisted locally. The opt is accepted (to keep the surface aligned
      // with the HTTP factory) but is a no-op here.
      const { tags: _tags, ...writeOpts } = opts;
      const { key, bytes } = await artifacts.writeText(content, writeOpts);
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
      // `listPointers` returns `ArtifactPointerRecord` (no `fence`/`tags`); the
      // wire pointer carries both. Local DIVERGENCE (Task 14): fence/tags are
      // not surfaced for list locally — default them so the shape matches.
      return {
        ok: true,
        pointers: pointers.map((p) => ({ ...p, fence: null, tags: [] })),
      };
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
      // The embedded `searchArtifacts` returns the minimal
      // `ArtifactSearchResultRecord` (r2_key/kind/title/snippet); the wire
      // `ArtifactSearchResult` additionally requires
      // resource/mime_type/produced_at/indexed_at. Local DIVERGENCE (Task 14):
      // those fields aren't available from the embedded search index, so they
      // are defaulted (null/0) to satisfy the wire shape.
      return {
        ok: true,
        results: results.map((r) => ({
          r2_key: r.r2_key,
          kind: r.kind,
          resource: null,
          mime_type: "",
          produced_at: 0,
          title: r.title,
          snippet: r.snippet,
          indexed_at: 0,
        })),
        total: results.length,
      };
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
      const ptr = await artifacts.getLatest(kind, resource);
      if (!ptr) return null;
      // The embedded backend's `getLatest` returns `ArtifactPointerRecord`,
      // which omits `fence`/`tags` (the wire `ArtifactPointer` has both). Local
      // DIVERGENCE (Task 14): `fence`/`tags` are not surfaced for getLatest
      // locally; default them so the wire shape is satisfied exactly.
      return { ...ptr, fence: null, tags: [] };
    },

    async addRelationship(
      fromKey: string,
      toKeyOrUri: string,
      type: string,
      _metadata?: Record<string, unknown>,
    ): Promise<ArtifactRelationshipOkResponse> {
      // HTTP factory disambiguates to_key vs to_uri by the `://` heuristic; the
      // embedded backend takes a `{to_key?, to_uri?}` discriminated object.
      const isUri = toKeyOrUri.includes("://");
      await artifacts.addRelationship(
        fromKey,
        isUri ? { to_uri: toKeyOrUri } : { to_key: toKeyOrUri },
        type,
      );
      return { ok: true };
    },

    async listRelationships(
      key: string,
    ): Promise<ArtifactRelationshipListResponse> {
      const rels = await artifacts.listRelationships(key);
      // The embedded `ArtifactRelationship` omits `metadata` (the wire shape
      // requires it). Local DIVERGENCE (Task 14): relationship metadata is not
      // surfaced locally; default to `{}` so the wire shape is satisfied.
      const relationships = rels.map((r) => ({ ...r, metadata: {} }));
      return { ok: true, relationships };
    },
  };
}

/** Gate methods (mirrors `createGateMethods` in `gates.ts`). */
function createLocalGateMethods(project: EmbeddedProject) {
  // Map the embedded `GateRecord` (await_type/status typed as `string`, no
  // `data`) to the wire `Gate`. The enum fields are narrowed with a typed
  // assertion (the values ARE valid enum members; the embedded type is just
  // widened to string), and `data` defaults to `{}` (the embedded GateRecord
  // carries none — a minor local divergence, harmless for gate semantics).
  const toGate = (g: GateRecord): Gate => ({
    id: g.id,
    resource: g.resource,
    await_type: g.await_type as Gate["await_type"],
    status: g.status as Gate["status"],
    fence: g.fence,
    timeout_at: g.timeout_at,
    resolved_at: g.resolved_at,
    resolution: g.resolution,
    created_at: g.created_at,
    created_by: g.created_by,
    data: {},
  });

  return {
    async list(query?: {
      resource?: string;
      status?: string;
      limit?: string;
    }): Promise<GateListResponse> {
      const gates = await project.listGates({
        resource: query?.resource,
        status: query?.status as GateRecord["status"] | undefined,
      });
      return { ok: true, gates: gates.map(toGate) };
    },

    async create(req: CreateGateRequest): Promise<GateResponse> {
      const gate = await project.createGate(
        req.resource,
        req.await_type,
        req.fence,
        req.timeout_at,
      );
      return { ok: true, gate: toGate(gate) };
    },

    async resolve(
      gateId: string,
      req?: { resolution?: string },
    ): Promise<GateResponse> {
      await project.resolveGate(gateId, req?.resolution);
      const gates = await project.listGates();
      const gate = gates.find((g) => g.id === gateId);
      if (!gate) throw new Error(`Gate not found: ${gateId}`);
      return { ok: true, gate: toGate(gate) };
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
      // SignalRecord.kind is widened to `string`; the wire Signal.kind is the
      // SignalKind enum. The stored kinds ARE valid members (written via the
      // same enum on send), so narrow with a typed assertion per row.
      return {
        ok: true,
        signals: signals.map((s) => ({
          ...s,
          kind: s.kind as Signal["kind"],
        })),
      };
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

    async ack(_signalId: string): Promise<AckSignalResponse> {
      // The wire AckSignalResponse is just `{ ok: true }`; the embedded ack's
      // `found`/`authorized` flags are not part of the wire shape, so they are
      // intentionally dropped (the HTTP factory's `ack` also returns only
      // `{ ok: true }`). Local mode is single-machine: the acker is "local",
      // matching the inbox identity used in `listSignals("local")`.
      await project.ackSignal(_signalId, "local");
      return { ok: true };
    },
  };
}

/** Journal methods (mirrors `createJournalMethods` in `journal.ts`). */
function createLocalJournalMethods(project: EmbeddedProject) {
  return {
    async query(opts?: {
      resource?: string;
      kind?: string;
      after_seq?: string;
      limit?: string;
    }): Promise<JournalResponse> {
      const events = await project.listJournal({
        resource: opts?.resource,
        kind: opts?.kind,
        after_seq: opts?.after_seq ? Number(opts.after_seq) : undefined,
        limit: opts?.limit ? Number(opts.limit) : undefined,
      });
      // The embedded `JournalEvent` is the minimal projection (no token_id /
      // data / source / source_version, which the DO journal route returns).
      // Local DIVERGENCE (Task 14): those are defaulted (null/{}) so the wire
      // shape matches exactly.
      return {
        ok: true,
        events: events.map((e) => ({
          ...e,
          token_id: null,
          data: {},
          source: null,
          source_version: null,
        })),
      };
    },
  };
}

/** Presence methods (mirrors `createPresenceMethods` in `presence.ts`). */
function createLocalPresenceMethods(project: EmbeddedProject) {
  return {
    async heartbeat(
      machine: string,
      info?: Record<string, unknown>,
    ): Promise<PresenceHeartbeatSuccessResponse> {
      await project.heartbeat(machine, info);
      return { ok: true };
    },

    async list(): Promise<PresenceListResponse> {
      // Wire shape: `{ ok, machines: [{ machine, last_seen, info }] }` — the key
      // is `machines`, not `presence`. (The prior `as unknown as` cast hid this
      // mislabel.) `Presence` matches the item shape exactly.
      const machines = await project.listPresence();
      return { ok: true, machines };
    },

    async listAll(): Promise<PresenceAllListResponse> {
      // DIVERGENCE (deferred to Task 14): the remote `presence/all` returns ALL
      // machines with a computed `active` (last_seen vs TTL cutoff), including
      // stale ones. `EmbeddedProject` only exposes `listPresence()`, which
      // already filters to active machines (last_seen > cutoff) — so every row
      // returned here IS active, making `active: true` correct PER ROW, but
      // stale machines are omitted (the remote would include them as
      // active:false). Closing the gap needs a `listAllPresence` lift onto the
      // CoordinationBackend interface + both impls (coordinationOps already has
      // the op); that exceeds this method's scope.
      const presence = await project.listPresence();
      const machines = presence.map((p) => ({ ...p, active: true }));
      return { ok: true, machines };
    },
  };
}

/** Schema methods (mirrors `createSchemaMethods` in `schema.ts`). */
function createLocalSchemaMethods(project: EmbeddedProject) {
  return {
    async get(): Promise<{ ok: true; schema: unknown; version: number }> {
      const current = await project.getCurrentSchema();
      // Mirror the DO `/schema/current` shape: `schema` is the schema RECORD
      // (`{ version, definition }`, with `definition` the raw TOML string) — the
      // stored definition is TOML, NOT JSON, so it must not be JSON.parsed.
      return {
        ok: true,
        schema: current,
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
        strategy,
      });
      return { ok: true, version: result.version ?? 0, diff: result.changes };
    },

    async history(_opts?: { limit?: string }): Promise<{
      ok: true;
      entries: unknown[];
    }> {
      // Schema history DATA exists locally — applySchema inserts a row per
      // version into `_schema_history`, so every version is retained. It is not
      // surfaced here because there is no matching REMOTE endpoint (the Worker
      // exposes no schema-history route; the cloudflare branch's
      // `schema.history` would 404). So this method is effectively unimplemented
      // on BOTH sides; returning an empty list keeps the two branches at parity
      // rather than diverging. (Tracked for Task 14 docs: whether to drop this
      // dead method from the facade.)
      return { ok: true, entries: [] };
    },
  };
}

/** Summary methods (mirrors `createSummaryMethods` in `summary.ts`). */
function createLocalSummaryMethods(project: EmbeddedProject) {
  return {
    async get(): Promise<SummaryResponse> {
      const summary = await project.getSummary();
      // `ProjectSummary` is structurally identical to the wire `project` shape.
      return { ok: true, project: summary };
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
      // `searchAll` returns `UnifiedSearchResult[]` — the exact element type of
      // the wire `results`. The wire response also requires `total`.
      return { ok: true, results, total: results.length };
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
      // The op result is structurally identical to the wire response.
      return {
        ok: true,
        created_entities: result.created_entities,
        created_relationships: result.created_relationships,
        journal_seq: result.journal_seq,
      };
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
      // no list op, so derive from the current schema definition. The stored
      // definition is TOML (mirroring the DO `/template/list`, which parses via
      // `constraintOps.resolveCurrentSchema`), so parse it with the core TOML
      // parser — NOT JSON.parse.
      const current = await project.getCurrentSchema();
      if (!current.definition) return { ok: true, templates: [] };
      const parsed = parseTilaSchemaToml(current.definition) as {
        templates?: Record<
          string,
          {
            description?: string;
            entities?: Record<string, { type: string; data?: unknown }>;
          }
        >;
      };
      // Derive `variables` by scanning each template's entity `data` for
      // `{{name}}` placeholders — the same `/\{\{(\w+)\}\}/` substitution
      // `templateOps.instantiateTemplate` applies (#5). This gives consumers a
      // real, non-empty variable list to drive `instantiate(vars)` locally,
      // rather than the previous silent `[]`.
      const extractVars = (def: {
        entities?: Record<string, { data?: unknown }>;
      }): string[] => {
        const found = new Set<string>();
        const walk = (v: unknown): void => {
          if (typeof v === "string") {
            for (const m of v.matchAll(/\{\{(\w+)\}\}/g)) found.add(m[1]);
          } else if (Array.isArray(v)) {
            for (const item of v) walk(item);
          } else if (v && typeof v === "object") {
            for (const item of Object.values(v)) walk(item);
          }
        };
        for (const ent of Object.values(def.entities ?? {})) walk(ent.data);
        return [...found].sort();
      };
      const templates = Object.entries(parsed.templates ?? {}).map(
        ([name, def]) => ({
          name,
          type: Object.values(def.entities ?? {})[0]?.type ?? "",
          description: def.description ?? null,
          variables: extractVars(def),
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
    // `issue`/`revoke` carry the HTTP facade's explicit parameter shape (derived
    // from `TilaFacade["tokens"]` so they cannot drift) — a zero-param stub would
    // make `_assertLocalSurfaceMatchesFacade` pass vacuously for them. `list` is
    // genuinely zero-param on the HTTP side too.
    async issue(
      ..._args: Parameters<TilaFacade["tokens"]["issue"]>
    ): Promise<never> {
      throw new LocalUnsupportedError("tokens.issue");
    },
    async revoke(
      ..._args: Parameters<TilaFacade["tokens"]["revoke"]>
    ): Promise<never> {
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

// ---------------------------------------------------------------------------
// Compile-time contract: the local resource surface MUST be structurally
// assignable to the HTTP facade surface (minus `close`, which createTila adds).
// This is the highest-leverage guard — if any adapter's method NAME, ARG shape,
// or RETURN shape drifts from the HTTP factory it mirrors, this line becomes a
// build error instead of a silent runtime divergence. Do NOT satisfy it by
// widening the adapter return types or re-adding `as unknown as` casts in the
// method bodies; fix the body to return the correct wire shape.
// A per-resource mapped check: each adapter resource must be assignable to the
// matching facade resource. A mapped type (vs a single `extends`) makes a drift
// name the OFFENDING resource key at the failing property, instead of an opaque
// whole-object `'true' is not assignable to 'never'`.
type _SurfaceMatch<
  Local extends Record<string, unknown>,
  Facade extends Record<string, unknown>,
> = {
  [K in keyof Facade]: K extends keyof Local
    ? Local[K] extends Facade[K]
      ? true
      : never
    : never;
};
const _assertLocalSurfaceMatchesFacade: _SurfaceMatch<
  ReturnType<typeof buildLocalResources>,
  Omit<TilaFacade, "close">
> = {
  tasks: true,
  records: true,
  claims: true,
  artifacts: true,
  gates: true,
  signals: true,
  journal: true,
  presence: true,
  schema: true,
  summary: true,
  search: true,
  templates: true,
  tokens: true,
};
void _assertLocalSurfaceMatchesFacade;
