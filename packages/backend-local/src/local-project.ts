import type { Database } from "bun:sqlite";
import type {
  ApplySchemaInput,
  ApplySchemaOutput,
  CoordinationBackend,
  CreateEntityInput,
  EntityBackend,
  EntityListFilter,
  GateBackend,
  GateFilter,
  GateRecord,
  JournalBackend,
  JournalEvent,
  JournalQuery,
  ProjectSummary,
  RelationshipFilter,
  RelationshipInput,
  SchemaBackend,
  SchemaRecord,
  SendSignalInput,
  SignalBackend,
  SignalRecord,
  SummaryBackend,
} from "@tila/core";
import type {
  Claim,
  Entity,
  EntityRelationship,
  Presence,
} from "@tila/schemas";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";

import {
  coordinationOps,
  entityOps,
  gateOps,
  journalOps,
  readyOps,
  relationshipOps,
  type schema,
  schemaOps,
  signalOps,
} from "@tila/ops-sqlite";

import type { AcquireResult } from "@tila/core";
import { createLocalConnection } from "./connection";
import type { LocalConnectionOptions } from "./connection";
import { withBusyRetry } from "./retry";

/**
 * Local SQLite implementation of EntityBackend and CoordinationBackend.
 *
 * All write methods use DEFERRED transactions wrapped in withBusyRetry (max 5 retries,
 * exponential backoff). The ops functions from @tila/ops-sqlite internally call
 * db.transaction(fn) which defaults to DEFERRED. PRAGMA busy_timeout=5000 ensures
 * SQLite waits up to 5 seconds before returning SQLITE_BUSY on a locked write.
 * See plan header for the documented BEGIN IMMEDIATE deviation rationale.
 *
 * Read methods use plain Drizzle queries (WAL allows concurrent reads).
 */
export class LocalProject
  implements
    EntityBackend,
    CoordinationBackend,
    JournalBackend,
    GateBackend,
    SignalBackend,
    SchemaBackend,
    SummaryBackend
{
  private constructor(
    private db: BunSQLiteDatabase<typeof schema> & { $client: Database },
    private _org: string,
    private _project: string,
  ) {}

  /**
   * Open a local project database. Applies PRAGMAs, runs migrations,
   * and returns a ready-to-use LocalProject instance.
   */
  static open(
    dbPath: string,
    org: string,
    project: string,
    options?: LocalConnectionOptions,
  ): LocalProject {
    const db = createLocalConnection(dbPath, org, project, options);
    return new LocalProject(db, org, project);
  }

  /** Close the underlying SQLite database. */
  close(): void {
    this.db.$client.close();
  }

  /** Expose the Drizzle DB instance for LocalArtifactBackend sharing. */
  getDb(): BunSQLiteDatabase<typeof schema> & { $client: Database } {
    return this.db;
  }

  // ---------- EntityBackend ----------

  async create(input: CreateEntityInput): Promise<Entity> {
    return withBusyRetry(() => {
      // Resolve current schema version (default to 1 if no schema applied)
      const currentSchema = schemaOps.getCurrentSchema(this.db);
      const schemaVersion = currentSchema?.version ?? 1;

      return entityOps.create(
        this.db,
        {
          id: input.id,
          type: input.type,
          data: input.data,
          created_by: input.created_by,
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
    const entity = await withBusyRetry(() => entityOps.get(this.db, id));
    if (!entity) throw new Error(`Entity not found: ${id}`);
    const resource = `${entity.type}:${id}`;
    const acquired = withBusyRetry(() =>
      coordinationOps.acquire(
        this.db,
        resource,
        "local",
        "local",
        "exclusive",
        30_000,
      ),
    );
    const result = withBusyRetry(() =>
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
      withBusyRetry(() =>
        coordinationOps.release(this.db, resource, acquired.fence, {
          actor: "local",
        }),
      );
    } catch {
      // Idempotent -- claim may have been deleted inside archive transaction
    }
    return result;
  }

  async archive(id: string): Promise<void> {
    const entity = await withBusyRetry(() => entityOps.get(this.db, id));
    if (!entity) throw new Error(`Entity not found: ${id}`);
    const resource = `${entity.type}:${id}`;
    const acquired = withBusyRetry(() =>
      coordinationOps.acquire(
        this.db,
        resource,
        "local",
        "local",
        "exclusive",
        30_000,
      ),
    );
    withBusyRetry(() =>
      entityOps.archive(this.db, id, acquired.fence, { actor: "local" }),
    );
    // No explicit release needed -- archive() deletes the claim row inside its transaction
  }

  async addRelationship(
    input: RelationshipInput,
  ): Promise<{ created: boolean }> {
    return withBusyRetry(() => {
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
    return withBusyRetry(() =>
      relationshipOps.deleteEntityRelationship(
        this.db,
        input.from_id,
        input.to_id,
        input.type,
        "local",
      ),
    );
  }

  // ---------- CoordinationBackend ----------

  async acquire(
    resource: string,
    machine: string,
    user: string,
    mode: "exclusive" | "owner" | "presence",
    ttlMs: number,
  ): Promise<AcquireResult> {
    return withBusyRetry(() =>
      coordinationOps.acquire(this.db, resource, machine, user, mode, ttlMs),
    );
  }

  async renew(
    resource: string,
    machine: string,
    user: string,
    fence: number,
    ttlMs: number,
  ): Promise<boolean> {
    const result = withBusyRetry(() =>
      coordinationOps.renew(this.db, resource, machine, user, fence, ttlMs),
    );
    return result.renewed;
  }

  async release(resource: string, fence: number): Promise<void> {
    withBusyRetry(() =>
      coordinationOps.release(this.db, resource, fence, { actor: "local" }),
    );
  }

  async state(resource: string): Promise<Claim | null> {
    return coordinationOps.state(this.db, resource);
  }

  async heartbeat(
    machine: string,
    info?: Record<string, unknown>,
  ): Promise<void> {
    withBusyRetry(() => coordinationOps.heartbeat(this.db, machine, info));
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
    return withBusyRetry(() => {
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
    return withBusyRetry(() => {
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
    withBusyRetry(() =>
      gateOps.resolveGate(this.db, gateId, resolution, { actor: "local" }),
    );
  }

  async cancelGate(gateId: string): Promise<void> {
    withBusyRetry(() =>
      gateOps.cancelGate(this.db, gateId, { actor: "local" }),
    );
  }

  // ---------- SignalBackend ----------

  async sendSignal(
    input: SendSignalInput,
    createdBy: string,
  ): Promise<{ id: string }> {
    return withBusyRetry(() =>
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

  async ackSignal(signalId: string): Promise<{ found: boolean }> {
    return withBusyRetry(() => signalOps.ack(this.db, signalId));
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
    return withBusyRetry(() => {
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

    // Group entities by type and status
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

  // ---------- Idempotency ----------

  /**
   * Check for a stored idempotent response.
   * Returns null if the key has not been stored.
   */
  checkIdempotency(key: string): { statusCode: number; body: string } | null {
    const row = this.db.$client
      .query(
        "SELECT status_code, response_json FROM _idempotency WHERE key = ?",
      )
      .get(key) as { status_code: number; response_json: string } | null;

    if (!row) return null;
    return { statusCode: row.status_code, body: row.response_json };
  }

  /**
   * Store an idempotent response. Uses INSERT OR IGNORE for first-writer-wins
   * semantics (matching D1's onConflictDoNothing behavior).
   */
  storeIdempotency(
    key: string,
    statusCode: number,
    responseJson: string,
  ): void {
    withBusyRetry(() =>
      this.db.$client
        .prepare(
          "INSERT OR IGNORE INTO _idempotency (key, created_at, response_json, status_code) VALUES (?, ?, ?, ?)",
        )
        .run(key, Date.now(), responseJson, statusCode),
    );
  }

  // ---------- Search ----------

  /**
   * Full-text search across indexed entities.
   * Read-only -- no withBusyRetry needed (WAL allows concurrent reads).
   */
  searchEntities(query: {
    q: string;
    entity_type?: string;
    limit?: number;
  }): ReturnType<typeof entityOps.searchEntities> {
    return entityOps.searchEntities(
      this.db as Parameters<typeof entityOps.searchEntities>[0],
      query,
    );
  }

  /**
   * Unified full-text search across entities and artifacts.
   * Read-only -- no withBusyRetry needed (WAL allows concurrent reads).
   */
  searchAll(query: { q: string; limit?: number }): ReturnType<
    typeof entityOps.searchAll
  > {
    return entityOps.searchAll(
      this.db as Parameters<typeof entityOps.searchAll>[0],
      query,
    );
  }
}
