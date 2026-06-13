import {
  type AcquireResult,
  type AddArtifactRefInput,
  type ApplySchemaInput,
  type ApplySchemaOutput,
  type ArchiveRecordInput,
  type CoordinationBackend,
  type CreateEntityInput,
  type CreateRecordInput,
  type EntityBackend,
  type EntityListFilter,
  type EntityTree,
  type GateBackend,
  type GateFilter,
  type GateRecord,
  type JournalBackend,
  type JournalEvent,
  type JournalQuery,
  type PatchRecordInput,
  type ProjectSummary,
  type PutRecordInput,
  type ReadyFilter,
  type RecordBackend,
  type RecordHistoryOptions,
  type RecordListFilter,
  type RecordPage,
  type RelationshipFilter,
  type RelationshipInput,
  type RenewResult,
  type SchemaBackend,
  type SchemaRecord,
  type SendSignalInput,
  type SetRecordInput,
  type SignalBackend,
  type SignalRecord,
  type SummaryBackend,
  applyRecordLegacyDefaults,
} from "@tila/core";
import {
  type RequestOrigin,
  TemplateInstantiateError,
  constraintOps,
  coordinationOps,
  entityOps,
  gateOps,
  journalOps,
  readyOps,
  recordOps,
  relationshipOps,
  type schema,
  schemaOps,
  searchReindexOps,
  signalOps,
  templateOps,
  validateRecordValue,
} from "@tila/ops-sqlite";
import type { TilaSchemaToml } from "@tila/schemas";

import type {
  Claim,
  CompactEntity,
  Entity,
  EntityArtifactReference,
  EntityRelationship,
  Presence,
  RecordHistoryItem,
  RecordListItem,
  RecordRow,
} from "@tila/schemas";
import { eq } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import {
  NotFoundError,
  RecordConstraintError,
  ReferenceConstraintError,
  TemplateError,
} from "./errors";

import { schema as opsSchema } from "@tila/ops-sqlite";
import { resolveEntityResource } from "@tila/ops-sqlite";
import { type SleepSync, withBusyRetry } from "./retry";

/**
 * Drizzle handle accepted by `EmbeddedProject`.
 *
 * The second generic is `void` (not `unknown`): both `drizzle-orm/bun-sqlite`
 * and `drizzle-orm/better-sqlite3` produce `BaseSQLiteDatabase<"sync", void, …>`,
 * so a host can pass either adapter's instance without a cast. `void` is
 * assignable to the `unknown` second-generic that `@tila/ops-sqlite` functions
 * declare, so delegation needs no cast either.
 */
export type EmbeddedDb = BaseSQLiteDatabase<"sync", void, typeof schema>;

/**
 * Runtime-agnostic SQLite implementation of every `@tila/core` backend
 * interface, including `RecordBackend`.
 *
 * Ported from `@tila/backend-local`'s `LocalProject`, with three Bun-coupled
 * dependencies replaced by injected, runtime-neutral primitives:
 *
 *  - C1 retry: `withBusyRetry` no longer calls `Bun.sleepSync`; it takes the
 *    injected `sleepSync` supplied to the constructor.
 *  - C2 idempotency: `checkIdempotency`/`storeIdempotency` are Drizzle queries
 *    against the `_idempotency` table, not raw `$client` SQL.
 *  - C3 handle: `getDb()` returns the neutral `BaseSQLiteDatabase`; `close()`
 *    calls the injected `close`.
 *
 * Connection construction (driver, PRAGMAs, migrations) is the host wrapper's
 * job (Task 4 for bun, Task 9 for node) — there is no `open`/`createConnection`
 * here.
 *
 * Write methods wrap ops in `withBusyRetry`. Read methods use plain Drizzle
 * queries (WAL allows concurrent reads).
 */
export class EmbeddedProject
  implements
    EntityBackend,
    CoordinationBackend,
    JournalBackend,
    GateBackend,
    SignalBackend,
    SchemaBackend,
    SummaryBackend,
    RecordBackend
{
  private readonly db: EmbeddedDb;
  private readonly sleepSync: SleepSync;
  private readonly _close: () => void;

  // `org`/`project` are accepted in the constructor opts for symmetry with the
  // wrapper API (and with EmbeddedArtifactBackend, which DOES use them for key
  // derivation), but EmbeddedProject itself is scoped to a single project DB and
  // never needs them — so they are intentionally not stored.
  constructor(opts: {
    db: EmbeddedDb;
    org: string;
    project: string;
    sleepSync: SleepSync;
    close: () => void;
  }) {
    this.db = opts.db;
    this.sleepSync = opts.sleepSync;
    this._close = opts.close;
  }

  /** Run `fn` with SQLITE_BUSY retry, using the injected blocking sleep. */
  private retry<T>(fn: () => T): T {
    return withBusyRetry(fn, this.sleepSync);
  }

  /** Close the underlying SQLite database via the injected closer. */
  close(): void {
    this._close();
  }

  /** Expose the neutral Drizzle DB instance for the embedded artifact backend. */
  getDb(): EmbeddedDb {
    return this.db;
  }

  // ---------- EntityBackend ----------

  async create(input: CreateEntityInput): Promise<Entity> {
    return this.retry(() => {
      const currentSchema = schemaOps.getCurrentSchema(this.db);
      const schemaVersion = currentSchema?.version ?? 1;

      return entityOps.create(
        this.db,
        {
          id: input.id,
          type: input.type,
          data: input.data,
          created_by: input.created_by,
          tags: input.tags,
        },
        schemaVersion,
        { actor: input.created_by },
      );
    });
  }

  async get(id: string): Promise<Entity | null> {
    return entityOps.get(this.db, id);
  }

  async list(filter?: EntityListFilter): Promise<Entity[]> {
    return entityOps.list(this.db, filter).entities;
  }

  async update(id: string, data: Partial<Entity["data"]>): Promise<Entity> {
    const entity = await this.retry(() => entityOps.get(this.db, id));
    if (!entity) throw new NotFoundError(`Entity ${id} not found`);
    const resource = `${entity.type}:${id}`;
    const acquired = this.retry(() =>
      coordinationOps.acquire(
        this.db,
        resource,
        "local",
        "local",
        "exclusive",
        30_000,
      ),
    );
    const result = this.retry(() =>
      entityOps.update(
        this.db,
        id,
        data as Record<string, unknown>,
        acquired.fence,
        { actor: "local" },
      ),
    );
    // Best-effort release -- archive() deletes claim inside its transaction, so this may be a no-op
    try {
      this.retry(() =>
        coordinationOps.release(this.db, resource, acquired.fence, {
          actor: "local/local",
        }),
      );
    } catch {
      // Idempotent -- claim may have been deleted inside archive transaction
    }
    return result;
  }

  async archive(id: string): Promise<void> {
    const entity = await this.retry(() => entityOps.get(this.db, id));
    if (!entity) throw new NotFoundError(`Entity ${id} not found`);
    const resource = `${entity.type}:${id}`;
    const acquired = this.retry(() =>
      coordinationOps.acquire(
        this.db,
        resource,
        "local",
        "local",
        "exclusive",
        30_000,
      ),
    );
    this.retry(() =>
      entityOps.archive(this.db, id, acquired.fence, { actor: "local" }),
    );
    // No explicit release needed -- archive() deletes the claim row inside its transaction
  }

  async addRelationship(
    input: RelationshipInput,
  ): Promise<{ created: boolean }> {
    return this.retry(() => {
      const currentSchema = schemaOps.getCurrentSchema(this.db);
      const schemaVersion = currentSchema?.version ?? 1;
      return relationshipOps.insertEntityRelationship(
        this.db,
        {
          from_id: input.from_id,
          to_id: input.to_id,
          type: input.type,
          schema_version: schemaVersion,
        },
        "local",
      );
    });
  }

  async listRelationships(
    filter?: RelationshipFilter,
  ): Promise<EntityRelationship[]> {
    return relationshipOps.listEntityRelationships(this.db, filter);
  }

  async removeRelationship(
    input: RelationshipInput,
  ): Promise<{ removed: boolean }> {
    return this.retry(() =>
      relationshipOps.deleteEntityRelationship(
        this.db,
        input.from_id,
        input.to_id,
        input.type,
        "local",
      ),
    );
  }

  /**
   * Tasks whose blockers are all resolved. Mirrors the DO `/entity/ready`
   * route (entity-routes.ts ~225): delegates to `readyOps.computeReadyEntities`
   * with the same option mapping. Read-only.
   */
  async listReady(filter?: ReadyFilter): Promise<Entity[]> {
    return readyOps.computeReadyEntities(this.db, {
      type: filter?.type,
      parent: filter?.parent,
      limit: filter?.limit,
      includeSoftBlocked: filter?.includeSoftBlocked,
    });
  }

  /**
   * Parent-child relationship tree: compact nodes (mirroring the DO compact
   * list, entity-routes.ts ~200, via `entityOps.compactEntity` over the active
   * claims) plus the parent-child edges (`relationshipOps`). The caller builds
   * the nesting from `edges`. `rootId` is accepted for parity but the full set
   * of nodes/edges is returned so the caller can scope the render locally.
   * Read-only.
   */
  async tree(_rootId?: string): Promise<EntityTree> {
    const activeClaims = coordinationOps.listClaims(this.db);
    const { entities } = entityOps.list(this.db, { archived: 0 });
    const stats = entityOps.getCompactEntityStats(
      this.db,
      entities.map((entity) => entity.id),
    );
    const nodes: CompactEntity[] = entities.map((e) =>
      entityOps.compactEntity(this.db, e, activeClaims, stats),
    );
    const edges = relationshipOps.listEntityRelationships(this.db, {
      type: "parent-child",
    });
    return { nodes, edges };
  }

  /**
   * Fenced entity update. Mirrors the DO `/entity/update/:id` route
   * (entity-routes.ts ~250): passes the caller-supplied `fence` straight to
   * `entityOps.update`, which validates it via `assertResourceFence` and throws
   * a fence-conflict on a stale fence. Unlike `update()`, this does NOT
   * auto-acquire a claim — the caller owns the fence.
   */
  async updateWithFence(
    id: string,
    data: Partial<Entity["data"]>,
    fence: number,
  ): Promise<Entity> {
    return this.retry(() =>
      entityOps.update(this.db, id, data as Record<string, unknown>, fence, {
        actor: "local",
        tokenId: null,
        source: null,
        sourceVersion: null,
      }),
    );
  }

  /**
   * Attach an artifact reference to a task. Mirrors the DO
   * `/entity/artifact-ref` route (entity-routes.ts ~534-604) guard-for-guard so
   * CLI/SDK/MCP get the SAME clean errors locally as remote:
   *  (a) entity-existence pre-check -> `NotFoundError` (DO 404, route ~552);
   *  (b) `checkReferenceSlotDeclared` gated on a schema -> `ReferenceConstraintError`
   *      (DO 422 `constraint-violation`, route ~561-570);
   *  (c) FK/CHECK SQLite failures translated to clean errors (DO 404/400,
   *      route ~584-602) — FK -> `NotFoundError` (missing artifact pointer),
   *      CHECK -> `ReferenceConstraintError`.
   */
  async addArtifactRef(input: AddArtifactRefInput): Promise<void> {
    // (a) Entity must exist (DO route ~552).
    const entity = entityOps.get(this.db, input.entity_id);
    if (!entity) {
      throw new NotFoundError(`Entity ${input.entity_id} not found`);
    }

    // (b) Slot must be declared when a schema declares reference slots
    // (DO route ~561-570). No-op when no schema is applied (permissive).
    const currentSchema = constraintOps.resolveCurrentSchema(this.db);
    if (currentSchema) {
      const slotCheck = constraintOps.checkReferenceSlotDeclared(
        currentSchema,
        entity.type,
        input.slot,
      );
      if (!slotCheck.ok) {
        throw new ReferenceConstraintError(slotCheck.message);
      }
    }

    // (c) Insert, translating raw SQLite FK/CHECK failures into clean errors
    // (DO route ~584-602). `this.retry(...)` runs synchronously (withBusyRetry
    // is sync) and returns void here — not a floating promise.
    try {
      this.retry(() =>
        relationshipOps.insertEntityArtifactReference(
          this.db,
          {
            entity_id: input.entity_id,
            artifact_key: input.artifact_key,
            slot: input.slot,
            metadata: input.metadata,
          },
          "local",
        ),
      );
    } catch (err) {
      const msg = String(err);
      if (msg.includes("FOREIGN KEY constraint failed")) {
        throw new NotFoundError(
          "Entity or artifact not found. Ensure both entity_id and artifact_key exist.",
        );
      }
      if (msg.includes("CHECK constraint failed")) {
        throw new ReferenceConstraintError(
          "CHECK constraint failed on entity_id or artifact_key",
        );
      }
      throw err;
    }
  }

  /**
   * List artifact references for a task. Mirrors the DO
   * `/entity/artifact-refs` route (entity-routes.ts ~607). Read-only.
   */
  async listArtifactRefs(entityId: string): Promise<EntityArtifactReference[]> {
    return relationshipOps.listEntityArtifactReferences(this.db, {
      entity_id: entityId,
    });
  }

  // ---------- CoordinationBackend ----------

  async acquire(
    resource: string,
    machine: string,
    user: string,
    mode: "exclusive" | "owner" | "presence",
    ttlMs: number,
  ): Promise<AcquireResult> {
    const canonicalResource =
      resolveEntityResource(this.db, resource) ?? resource;
    return this.retry(() =>
      coordinationOps.acquire(
        this.db,
        canonicalResource,
        machine,
        user,
        mode,
        ttlMs,
      ),
    );
  }

  async renew(
    resource: string,
    machine: string,
    user: string,
    fence: number,
    ttlMs: number,
  ): Promise<RenewResult> {
    // Return the FULL result (not a bare boolean): `renewed` distinguishes
    // loss-of-claim (missing / expired / holder mismatch) from success, and
    // `expires_at` is the REAL stored expiry — callers must not recompute it.
    // Mirrors the DO `/coord/renew` contract (409 `renew-failed` on !renewed).
    const canonicalResource =
      resolveEntityResource(this.db, resource) ?? resource;
    return this.retry(() =>
      coordinationOps.renew(
        this.db,
        canonicalResource,
        machine,
        user,
        fence,
        ttlMs,
      ),
    );
  }

  async release(resource: string, fence: number): Promise<void> {
    const canonicalResource =
      resolveEntityResource(this.db, resource) ?? resource;
    const claim = coordinationOps.state(this.db, canonicalResource);
    const actor = claim ? `${claim.machine}/${claim.user}` : "local/local";

    this.retry(() =>
      coordinationOps.release(this.db, canonicalResource, fence, {
        actor,
      }),
    );
  }

  async state(resource: string): Promise<Claim | null> {
    const canonicalResource =
      resolveEntityResource(this.db, resource) ?? resource;
    return coordinationOps.state(this.db, canonicalResource);
  }

  async heartbeat(
    machine: string,
    info?: Record<string, unknown>,
  ): Promise<void> {
    this.retry(() => coordinationOps.heartbeat(this.db, machine, info));
  }

  async listPresence(): Promise<Presence[]> {
    return coordinationOps.listPresence(this.db);
  }

  async listClaims(): Promise<Claim[]> {
    return coordinationOps.listClaims(this.db);
  }

  // ---------- JournalBackend ----------

  async listJournal(query: JournalQuery): Promise<JournalEvent[]> {
    const rows = journalOps.listJournal(this.db, query);
    return rows.map((row) => ({
      seq: row.seq,
      t: row.t,
      kind: row.kind,
      resource: row.resource,
      actor: row.actor,
      fence: row.fence,
    }));
  }

  // ---------- GateBackend ----------

  async createGate(
    resource: string,
    awaitType: string,
    fence: number,
    timeoutAt?: number,
  ): Promise<GateRecord> {
    const id = `gate_${crypto.randomUUID()}`;
    return this.retry(() => {
      const row = gateOps.createGate(
        this.db,
        {
          id,
          resource,
          await_type: awaitType,
          fence,
          timeout_at: timeoutAt,
        },
        { actor: "local" },
      );
      return {
        id: row.id,
        resource: row.resource,
        await_type: row.await_type,
        status: row.status,
        fence: row.fence,
        timeout_at: row.timeout_at,
        resolved_at: row.resolved_at,
        resolution: row.resolution,
        created_at: row.created_at,
        created_by: row.created_by,
      };
    });
  }

  async listGates(filter?: GateFilter): Promise<GateRecord[]> {
    return this.retry(() => {
      const rows = gateOps.listGates(this.db, filter);
      return rows.map((row) => ({
        id: row.id,
        resource: row.resource,
        await_type: row.await_type,
        status: row.status,
        fence: row.fence,
        timeout_at: row.timeout_at,
        resolved_at: row.resolved_at,
        resolution: row.resolution,
        created_at: row.created_at,
        created_by: row.created_by,
      }));
    });
  }

  async resolveGate(gateId: string, resolution?: string): Promise<void> {
    this.retry(() =>
      gateOps.resolveGate(this.db, gateId, resolution, { actor: "local" }),
    );
  }

  async cancelGate(gateId: string): Promise<void> {
    this.retry(() => gateOps.cancelGate(this.db, gateId, { actor: "local" }));
  }

  // ---------- SignalBackend ----------

  async sendSignal(
    input: SendSignalInput,
    createdBy: string,
  ): Promise<{ id: string }> {
    return this.retry(() =>
      signalOps.send(this.db, {
        target: input.target,
        kind: input.kind,
        resource: input.resource,
        payload: input.payload,
        ttl_ms: input.ttl_ms,
        created_by: createdBy,
      }),
    );
  }

  async listSignals(tokenName: string): Promise<SignalRecord[]> {
    const rows = signalOps.inbox(this.db, tokenName);
    return rows.map((row) => ({
      id: row.id,
      target: row.target,
      kind: row.kind,
      resource: row.resource,
      payload: row.payload,
      created_by: row.created_by,
      created_at: row.created_at,
      expires_at: row.expires_at,
      acked_at: row.acked_at,
    }));
  }

  async ackSignal(
    signalId: string,
    acker: string,
  ): Promise<{ found: boolean; authorized: boolean }> {
    return this.retry(() => signalOps.ack(this.db, signalId, acker));
  }

  // ---------- SchemaBackend ----------

  async getCurrentSchema(): Promise<SchemaRecord> {
    const row = schemaOps.getCurrentSchema(this.db);
    return {
      version: row?.version ?? null,
      definition: row?.definition ?? null,
    };
  }

  async applySchema(input: ApplySchemaInput): Promise<ApplySchemaOutput> {
    return this.retry(() => {
      const result = schemaOps.applySchema(
        this.db,
        input.definition,
        "local",
        input.strategy,
      );
      if (result.ok) {
        return {
          ok: true,
          version: result.version,
          changes: result.changes,
          noChange: false,
        };
      }
      if (result.reason === "no-change") {
        return {
          ok: true,
          version: null,
          changes: [],
          noChange: true,
        };
      }
      // destructive
      return {
        ok: false,
        version: null,
        changes: result.changes,
        reason: "destructive",
        hint: result.hint,
      };
    });
  }

  // ---------- SummaryBackend ----------

  async getSummary(): Promise<ProjectSummary> {
    const { entities } = entityOps.list(this.db, { archived: 0 });
    const claims = coordinationOps.listClaims(this.db);
    const readyEntities = readyOps.computeReadyEntities(this.db);
    const recentEvents = journalOps.listJournal(this.db, { limit: 10 });
    const presenceList = coordinationOps.listPresence(this.db);

    const entityCounts: Record<string, number> = {};
    const statusCounts: Record<string, number> = {};
    for (const e of entities) {
      entityCounts[e.type] = (entityCounts[e.type] ?? 0) + 1;
      const status = (e.data as Record<string, unknown>)?.status;
      if (typeof status === "string") {
        statusCounts[status] = (statusCounts[status] ?? 0) + 1;
      }
    }

    const payload: ProjectSummary = {
      entity_count: entities.length,
      entity_counts: entityCounts,
      status_counts: statusCounts,
      active_claims: claims.length,
      ready_count: readyEntities.length,
      online_machines: presenceList.map((p) => p.machine),
      token_estimate: 0,
      recent_events: recentEvents.map((ev) => ({
        seq: ev.seq,
        t: ev.t,
        kind: ev.kind,
        resource: ev.resource,
        actor: ev.actor,
      })),
    };
    payload.token_estimate = Math.ceil(JSON.stringify(payload).length / 4);
    return payload;
  }

  // ---------- RecordBackend ----------
  //
  // Mirrors the DO record router's actor/origin/schema_version resolution
  // (see backend-do `record-routes.ts`): records resolve `schema_version` from
  // the current applied schema (0 when none), `actor: "local"`, and a local
  // `RequestOrigin`. The camelCase RecordBackend inputs (`sourceArtifactKey`)
  // are translated to the ops/DB snake_case (`source_artifact_key`) here.
  // `canonicalArtifactKey`/`sourceArtifactKey` default to null because R2
  // snapshotting is Worker-only.

  /**
   * Resolve the parsed current schema (or null) plus the record schema_version,
   * the DO way: version is the current schema's version when a schema is
   * applied, else 0. Resolving both together mirrors the DO route, which
   * computes `currentSchema` once and reuses it for validation + version.
   */
  private resolveRecordSchema(): {
    currentSchema: TilaSchemaToml | null;
    schemaVersion: number;
  } {
    const currentSchema = constraintOps.resolveCurrentSchema(this.db);
    const schemaVersion = currentSchema
      ? (schemaOps.getCurrentSchema(this.db)?.version ?? 0)
      : 0;
    return { currentSchema, schemaVersion };
  }

  /**
   * Schema-constraint check on the record TYPE. Mirrors the DO route's
   * `checkRecordTypeDeclared(currentSchema, type)` guard (record-routes.ts
   * ~92/173/253/301/348) — enforced on create/set/patch/archive/unarchive.
   * No-op when no schema is applied (permissive, exactly like the DO).
   */
  private assertRecordTypeDeclared(
    currentSchema: TilaSchemaToml | null,
    type: string,
  ): void {
    if (!currentSchema) return;
    const check = constraintOps.checkRecordTypeDeclared(currentSchema, type);
    if (!check.ok) {
      throw new RecordConstraintError(check.message);
    }
  }

  /**
   * Schema-constraint check on the record VALUE. Mirrors the DO route's
   * `validateRecordValue(value, recordDef)` guard on the value-bearing paths
   * (record-routes.ts ~99 create, ~180 set). Only runs when the current schema
   * declares the record type (`currentSchema.records?.[type]`), exactly as the
   * DO does. Patch does NOT validate (the DO only type-checks patch).
   */
  private assertRecordValueValid(
    currentSchema: TilaSchemaToml | null,
    type: string,
    value: Record<string, unknown>,
  ): void {
    if (!currentSchema) return;
    const recordDef = currentSchema.records?.[type];
    if (!recordDef) return;
    const result = validateRecordValue(value, recordDef);
    if (!result.ok) {
      throw new RecordConstraintError(result.errors.join("; "));
    }
  }

  private localOrigin(): RequestOrigin {
    return {
      actor: "local",
      tokenId: null,
      source: null,
      sourceVersion: null,
    };
  }

  async createRecord(input: CreateRecordInput): Promise<RecordRow> {
    const { currentSchema, schemaVersion } = this.resolveRecordSchema();
    // DO parity: record-routes.ts ~92 (type) + ~99 (value).
    this.assertRecordTypeDeclared(currentSchema, input.type);
    this.assertRecordValueValid(currentSchema, input.type, input.value);
    return this.retry(() =>
      recordOps.createRecord(
        this.db,
        {
          type: input.type,
          key: input.key,
          value: input.value,
          tags: input.tags,
          message: input.message ?? null,
          source_artifact_key: input.sourceArtifactKey ?? null,
          canonical_artifact_key: null,
          schema_version: schemaVersion,
          actor: "local",
        },
        this.localOrigin(),
      ),
    );
  }

  async setRecord(input: SetRecordInput): Promise<RecordRow> {
    const { currentSchema, schemaVersion } = this.resolveRecordSchema();
    // DO parity: record-routes.ts ~173 (type) + ~180 (value).
    this.assertRecordTypeDeclared(currentSchema, input.type);
    this.assertRecordValueValid(currentSchema, input.type, input.value);
    return this.retry(() =>
      recordOps.setRecord(
        this.db,
        {
          type: input.type,
          key: input.key,
          value: input.value,
          fence: input.fence,
          tags: input.tags,
          message: input.message ?? null,
          source_artifact_key: input.sourceArtifactKey ?? null,
          canonical_artifact_key: null,
          schema_version: schemaVersion,
          actor: "local",
        },
        this.localOrigin(),
      ),
    );
  }

  async putRecord(input: PutRecordInput): Promise<RecordRow> {
    const { currentSchema, schemaVersion } = this.resolveRecordSchema();
    // DO parity: validateRecordWrite (record-routes.ts) — type + value gate.
    // Same assert helpers create/set use; conditional on a declared schema.
    this.assertRecordTypeDeclared(currentSchema, input.type);
    this.assertRecordValueValid(currentSchema, input.type, input.value);
    // The embedded backend has NO snapshot/R2 handling — create/set pass
    // canonical_artifact_key: null unconditionally, so put has nothing to
    // mirror (design C6/RC-3).
    return this.retry(() =>
      recordOps.putRecord(
        this.db,
        {
          type: input.type,
          key: input.key,
          value: input.value,
          tags: input.tags,
          message: input.message ?? null,
          source_artifact_key: input.sourceArtifactKey ?? null,
          canonical_artifact_key: null,
          schema_version: schemaVersion,
          actor: "local",
        },
        this.localOrigin(),
      ),
    );
  }

  async getRecord(type: string, key: string): Promise<RecordRow | null> {
    const result = recordOps.getRecord(this.db, type, key);
    if (!result) return result;

    // DO parity: record-routes.ts ~536-539 — apply legacy default enrichment
    // using the CURRENT schema (not the schema version the record was written
    // against), because new fields with default_for_legacy only exist in the
    // latest schema. The DO enriches only the GET path; list/history are NOT
    // enriched, so listRecords/listRecordHistory deliberately skip this.
    const currentSchema = constraintOps.resolveCurrentSchema(this.db);
    const enrichedValue = currentSchema
      ? applyRecordLegacyDefaults(result.value, currentSchema, result.type)
      : result.value;

    return { ...result, value: enrichedValue };
  }

  async patchRecord(input: PatchRecordInput): Promise<RecordRow> {
    const { currentSchema, schemaVersion } = this.resolveRecordSchema();
    // DO parity: record-routes.ts ~253 type-checks patch; it does NOT validate
    // the merged value (no validateRecordValue on the patch path).
    this.assertRecordTypeDeclared(currentSchema, input.type);
    return this.retry(() =>
      recordOps.patchRecord(
        this.db,
        {
          type: input.type,
          key: input.key,
          patch: input.patch,
          fence: input.fence,
          message: input.message ?? null,
          schema_version: schemaVersion,
          actor: "local",
        },
        this.localOrigin(),
      ),
    );
  }

  async archiveRecord(input: ArchiveRecordInput): Promise<RecordRow> {
    const { currentSchema, schemaVersion } = this.resolveRecordSchema();
    // DO parity: record-routes.ts ~301 type-checks archive.
    this.assertRecordTypeDeclared(currentSchema, input.type);
    return this.retry(() =>
      recordOps.archiveRecord(
        this.db,
        {
          type: input.type,
          key: input.key,
          fence: input.fence,
          message: input.message ?? null,
          schema_version: schemaVersion,
          actor: "local",
        },
        this.localOrigin(),
      ),
    );
  }

  async unarchiveRecord(input: ArchiveRecordInput): Promise<RecordRow> {
    const { currentSchema, schemaVersion } = this.resolveRecordSchema();
    // DO parity: record-routes.ts ~348 type-checks unarchive.
    this.assertRecordTypeDeclared(currentSchema, input.type);
    return this.retry(() =>
      recordOps.unarchiveRecord(
        this.db,
        {
          type: input.type,
          key: input.key,
          fence: input.fence,
          message: input.message ?? null,
          schema_version: schemaVersion,
          actor: "local",
        },
        this.localOrigin(),
      ),
    );
  }

  async listRecords(
    filter: RecordListFilter,
  ): Promise<RecordPage<RecordListItem>> {
    return recordOps.listRecords(this.db, {
      type: filter.type,
      includeArchived: filter.includeArchived,
      tag: filter.tag,
      tagFilter: filter.tagFilter,
      dataFilter: filter.dataFilter,
      limit: filter.limit,
    });
  }

  async listRecordHistory(
    type: string,
    key: string,
    opts?: RecordHistoryOptions,
  ): Promise<RecordPage<RecordHistoryItem>> {
    return recordOps.listRecordHistory(this.db, type, key, {
      limit: opts?.limit,
      includeValues: opts?.includeValues,
    });
  }

  /**
   * Record types of CURRENTLY-IN-USE (active, non-archived) records, sorted
   * and distinct. This is the IN-USE subset only — it deliberately does NOT
   * merge in schema-declared-but-unused types (see the `RecordBackend`
   * interface contract). Callers that want the merged "declared ∪ in-use" view
   * (e.g. the CLI `record types` default) compose it themselves from the schema
   * plus this method.
   */
  async listRecordTypesInUse(): Promise<string[]> {
    return recordOps.listRecordTypesInUse(this.db);
  }

  // ---------- Idempotency (C2: Drizzle, not raw $client) ----------
  //
  // AVAILABLE-BUT-UNWIRED (parity/future): these methods + the `_idempotency`
  // table exist so the embedded backend CAN honor an idempotency key, but NO
  // local resource adapter currently calls them — local mode relies on
  // primary-key-level dedup instead (a retried create of an existing id fails
  // rather than duplicating). This is a documented local divergence vs remote
  // (which honors `idempotency_key` via D1); see docs/02-ARCHITECTURE.md §1.6a
  // and the SDK README divergence list. Kept (not deleted) for parity and so a
  // future full-idempotency wiring has the storage already in place.

  /**
   * Check for a stored idempotent response. Returns null if the key is absent.
   */
  checkIdempotency(key: string): { statusCode: number; body: string } | null {
    const row = this.db
      .select({
        status_code: opsSchema.idempotency.status_code,
        response_json: opsSchema.idempotency.response_json,
      })
      .from(opsSchema.idempotency)
      .where(eq(opsSchema.idempotency.key, key))
      .get();

    if (!row) return null;
    return { statusCode: row.status_code, body: row.response_json };
  }

  /**
   * Store an idempotent response. First-writer-wins via `onConflictDoNothing`
   * (matching D1's `INSERT OR IGNORE` semantics).
   */
  storeIdempotency(
    key: string,
    statusCode: number,
    responseJson: string,
  ): void {
    this.retry(() =>
      this.db
        .insert(opsSchema.idempotency)
        .values({
          key,
          created_at: Date.now(),
          response_json: responseJson,
          status_code: statusCode,
        })
        .onConflictDoNothing()
        .run(),
    );
  }

  // ---------- Search ----------

  /**
   * Full-text search across indexed entities (with optional `tagFilter`).
   * Read-only -- no busy-retry needed (WAL allows concurrent reads).
   */
  searchEntities(query: {
    q: string;
    entity_type?: string;
    limit?: number;
    tagFilter?: string[];
  }): ReturnType<typeof entityOps.searchEntities> {
    return entityOps.searchEntities(this.db, query);
  }

  /**
   * Unified full-text search across entities, artifacts, and records
   * (with optional `tagFilter`). Read-only.
   */
  searchAll(query: {
    q: string;
    limit?: number;
    tagFilter?: string[];
  }): ReturnType<typeof entityOps.searchAll> {
    return entityOps.searchAll(this.db, query);
  }

  /**
   * Run a full local FTS reindex to completion. Mirrors the DO
   * `/search/reindex` job (artifact-routes.ts ~486) but synchronously — there
   * are no DO Alarms locally, so we loop `searchReindexOps.reindexBatch` until
   * `done` rather than scheduling batches across alarm ticks.
   *
   * Entity reindex is a FULL REBUILD: `resetEntitySearchDocs` clears the docs
   * first (DO parity, artifact-routes.ts ~501-503, issue #412) so the repopulate
   * picks up the latest entity name/title text. Artifact reindex is incremental
   * (only un-indexed pointers), matching the DO's artifact path which does NOT
   * reset.
   *
   * Returns the per-kind processed-row counts.
   */
  reindexSearch(kind: "artifact" | "entity" | "all" = "all"): {
    artifact: number;
    entity: number;
  } {
    const result = { artifact: 0, entity: 0 };
    const kinds: Array<"artifact" | "entity"> =
      kind === "all" ? ["artifact", "entity"] : [kind];

    return this.retry(() => {
      for (const k of kinds) {
        if (k === "entity") {
          // Full rebuild: clear then repopulate (DO parity, issue #412).
          searchReindexOps.resetEntitySearchDocs(this.db);
        }
        // Loop the batched op to completion. A generous batch keeps the local
        // (single-process) rebuild to one pass for typical project sizes.
        let total = 0;
        for (;;) {
          const batch = searchReindexOps.reindexBatch(this.db, {
            kind: k,
            batchSize: 500,
          });
          total += batch.processed;
          if (batch.done) break;
        }
        result[k] = total;
      }
      return result;
    });
  }

  // ---------- Templates ----------

  /**
   * Instantiate a schema template locally — a THIN wrapper over the shared
   * `templateOps.instantiateTemplate` (the single source of truth, also used by
   * the DO `/template/instantiate` route). This delegation eliminates the prior
   * ~120-line copy of the route body and the actor-default drift it caused.
   *
   * Per-caller difference is passed explicitly as the `origin`: a local actor
   * (defaulting to "local", vs the DO's "system") with no token/source/version.
   *
   * The op's `TemplateInstantiateError` is mapped 1:1 to the embedded
   * `TemplateError` (identical codes + messages) so CLI/SDK/MCP get the same
   * clean errors locally as the Worker returns remote. The whole call is wrapped
   * in `withBusyRetry` (SQLITE_BUSY), matching every other write method here.
   */
  instantiateTemplate(input: {
    template_name: string;
    root_id: string;
    vars?: Record<string, string>;
    actor?: string;
  }): {
    created_entities: string[];
    created_relationships: number;
    journal_seq: number;
  } {
    try {
      return this.retry(() =>
        templateOps.instantiateTemplate(this.db, {
          templateName: input.template_name,
          rootId: input.root_id,
          vars: input.vars ?? {},
          origin: {
            actor: input.actor ?? "local",
            tokenId: null,
            source: null,
            sourceVersion: null,
          },
        }),
      );
    } catch (err) {
      if (err instanceof TemplateInstantiateError) {
        throw new TemplateError(err.code, err.message);
      }
      throw err;
    }
  }
}
