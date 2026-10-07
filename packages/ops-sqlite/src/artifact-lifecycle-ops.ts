import {
  type ArtifactDeleteOptions,
  type ArtifactLifecycleRecord,
  ArtifactLifecycleRecordSchema,
  type ArtifactRevision,
  ArtifactRevisionSchema,
  artifactLifecycleKey,
  artifactRevisionKey,
} from "@tila/schemas";
import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNull,
  lte,
  ne,
  notExists,
  or,
  sql,
} from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { ArtifactVersionError } from "./artifact-version-error";
import { resolveCurrentSchema } from "./constraint-ops";
import { assertResourceFenceWithCanonical } from "./fence-ops";
import { type RequestOrigin, appendJournal } from "./journal-ops";
import * as schema from "./schema";

type Db = BaseSQLiteDatabase<"sync", unknown, typeof schema>;
type Operation = typeof schema.artifactLifecycleOperations.$inferSelect;
const systemOrigin: RequestOrigin = {
  actor: "system:sweep",
  principalId: "system:sweep",
  participantId: "system:sweep",
  environment: {},
};

export function isLineageDestroyed(db: Db, lineage: string): boolean {
  return (
    db
      .select()
      .from(schema.artifactLineages)
      .where(eq(schema.artifactLineages.id, lineage))
      .get()?.destroyed_at != null
  );
}

export function assertLineageWritable(db: Db, lineage: string): void {
  if (isLineageDestroyed(db, lineage))
    throw new ArtifactVersionError(
      410,
      "artifact-lineage-destroyed",
      "The artifact lineage has been permanently retired",
    );
}

export function revisionMetadata(db: Db, key: string): ArtifactRevision | null {
  const row = db
    .select()
    .from(schema.artifactRevisions)
    .where(eq(schema.artifactRevisions.r2_key, key))
    .get();
  if (!row) return null;
  const pointer = ArtifactRevisionSchema.parse(JSON.parse(row.metadata));
  const lineage = db
    .select()
    .from(schema.artifactLineages)
    .where(eq(schema.artifactLineages.id, row.lineage_id))
    .get();
  if (lineage?.destroyed_at != null) {
    pointer.tombstoned = 1;
    pointer.tombstoned_at ??= lineage.destroyed_at;
  }
  return pointer;
}

export function saveRevision(
  db: Db,
  pointer: ArtifactRevision,
  retentionAssigned = true,
): void {
  if (!pointer.lineage_id || pointer.revision == null) return;
  db.insert(schema.artifactRevisions)
    .values({
      r2_key: pointer.r2_key,
      lineage_id: pointer.lineage_id,
      revision: pointer.revision,
      metadata: JSON.stringify(ArtifactRevisionSchema.parse(pointer)),
      retention_assigned: retentionAssigned ? 1 : 0,
    })
    .onConflictDoNothing()
    .run();
}

function updateMetadata(db: Db, pointer: ArtifactRevision): void {
  db.update(schema.artifactRevisions)
    .set({ metadata: JSON.stringify(pointer) })
    .where(eq(schema.artifactRevisions.r2_key, pointer.r2_key))
    .run();
}

function recordFor(
  db: Db,
  pointer: ArtifactRevision,
  type: ArtifactLifecycleRecord["type"],
  at: number,
): ArtifactLifecycleRecord {
  const lineage = db
    .select()
    .from(schema.artifactLineages)
    .where(eq(schema.artifactLineages.id, required(pointer.lineage_id)))
    .get();
  if (!lineage)
    throw new ArtifactVersionError(
      404,
      "not-found",
      "Unknown artifact lineage",
    );
  return {
    format: "tila-artifact-lifecycle-v1",
    type,
    project_id: lineage.project_id,
    lineage_id: lineage.id,
    kind: lineage.kind,
    resource: lineage.resource,
    at,
    pointer,
  };
}

function enqueue(
  db: Db,
  record: ArtifactLifecycleRecord,
  requestId?: string,
): string {
  const id = artifactLifecycleKey(record);
  db.insert(schema.artifactLifecycleOperations)
    .values({
      id,
      lineage_id: record.lineage_id,
      record: JSON.stringify(record),
      request_id: requestId ?? null,
    })
    .onConflictDoNothing()
    .run();
  if (requestId) {
    const existing = required(
      db
        .select()
        .from(schema.artifactLifecycleOperations)
        .where(eq(schema.artifactLifecycleOperations.id, id))
        .get(),
    );
    // A second caller can accept the same outcome with its own retry key. Keep
    // a receipt without replacing the original immutable operation or its key.
    if (existing.request_id !== requestId)
      db.insert(schema.artifactLifecycleOperations)
        .values({
          id: `request:${requestId}`,
          lineage_id: existing.lineage_id,
          record: existing.record,
          request_id: requestId,
          state: "done",
        })
        .onConflictDoNothing()
        .run();
  }
  return id;
}

function assertIdle(db: Db, lineage: string): void {
  if (
    db
      .select()
      .from(schema.artifactRevisionOperations)
      .where(
        and(
          eq(schema.artifactRevisionOperations.lineage_id, lineage),
          inArray(schema.artifactRevisionOperations.state, [
            "reserved",
            "accepted",
          ]),
        ),
      )
      .get()
  )
    throw new ArtifactVersionError(
      409,
      "artifact-lineage-busy",
      "A revision is still being published; retry",
      true,
    );
}

function replay(
  db: Db,
  requestId: string | undefined,
  target: string,
): Operation | undefined {
  if (!requestId) return;
  const op = db
    .select()
    .from(schema.artifactLifecycleOperations)
    .where(eq(schema.artifactLifecycleOperations.request_id, requestId))
    .get();
  if (
    op &&
    artifactLifecycleKey(
      ArtifactLifecycleRecordSchema.parse(JSON.parse(op.record)),
    ) !== target
  )
    throw new ArtifactVersionError(
      422,
      "idempotency-key-conflict",
      "Idempotency key reused with different input",
    );
  return op;
}

/** Accept deletion synchronously. Only the durable queue may delete the bytes. */
export function acceptDeletion(
  db: Db,
  key: string,
  options: ArtifactDeleteOptions,
  origin: RequestOrigin,
  reason: "manual" | "expired" | "destroy" = "manual",
  now = Date.now(),
): string | null {
  return db.transaction((tx) => {
    const pointer = revisionMetadata(tx, key);
    if (!pointer)
      throw new ArtifactVersionError(404, "not-found", "Unknown revision");
    const id = `${key}.tombstone.json`;
    if (replay(tx, options.idempotencyKey, id)) return id;
    if (reason === "manual") {
      if (!options.fence)
        throw new ArtifactVersionError(
          400,
          "missing-fence",
          "Versioned deletion requires a lineage fence",
        );
      assertResourceFenceWithCanonical(
        tx,
        `artifact:${pointer.lineage_id}`,
        options.fence,
        { requireLiveClaim: true },
      );
    }
    assertIdle(tx, required(pointer.lineage_id));
    if (reason === "expired") {
      const newer = tx
        .select()
        .from(schema.artifactPointers)
        .where(
          and(
            eq(
              schema.artifactPointers.lineage_id,
              required(pointer.lineage_id),
            ),
            eq(schema.artifactPointers.tombstoned, 0),
            isNull(schema.artifactPointers.blob_deleted_at),
            gt(schema.artifactPointers.revision, required(pointer.revision)),
          ),
        )
        .get();
      if (
        !newer ||
        pointer.expires_at == null ||
        pointer.expires_at > now ||
        pointer.tombstoned
      )
        return null;
      const retention = tx
        .select()
        .from(schema.artifactLifecycleOperations)
        .where(
          eq(schema.artifactLifecycleOperations.id, `${key}.retention.json`),
        )
        .get();
      if (retention && retention.state !== "done") return null;
    }
    const existing = tx
      .select()
      .from(schema.artifactLifecycleOperations)
      .where(eq(schema.artifactLifecycleOperations.id, id))
      .get();
    if (existing)
      return enqueue(
        tx,
        ArtifactLifecycleRecordSchema.parse(JSON.parse(existing.record)),
        options.idempotencyKey,
      );
    pointer.tombstoned = 1;
    pointer.tombstoned_at ??= now;
    updateMetadata(tx, pointer);
    tx.update(schema.artifactPointers)
      .set({
        tombstoned: 1,
        tombstoned_at: pointer.tombstoned_at,
        content_inline: null,
      })
      .where(eq(schema.artifactPointers.r2_key, key))
      .run();
    tx.delete(schema.artifactSearchDocs)
      .where(eq(schema.artifactSearchDocs.artifact_key, key))
      .run();
    appendJournal(tx, {
      ...origin,
      kind: reason === "expired" ? "artifact.expired" : "artifact.tombstoned",
      resource: key,
      fence: options.fence ?? null,
      data: {
        lineage_id: pointer.lineage_id,
        revision: pointer.revision,
        reason,
      },
    });
    return enqueue(
      tx,
      recordFor(tx, pointer, "tombstone", pointer.tombstoned_at),
      options.idempotencyKey,
    );
  });
}

export function destroyLineage(
  db: Db,
  lineageId: string,
  options: ArtifactDeleteOptions,
  origin: RequestOrigin,
) {
  return db.transaction((tx) => {
    const lineage = tx
      .select()
      .from(schema.artifactLineages)
      .where(eq(schema.artifactLineages.id, lineageId))
      .get();
    if (!lineage)
      throw new ArtifactVersionError(
        404,
        "not-found",
        "Unknown artifact lineage",
      );
    const record: ArtifactLifecycleRecord = {
      format: "tila-artifact-lifecycle-v1",
      type: "destroy",
      project_id: lineage.project_id,
      lineage_id: lineageId,
      kind: lineage.kind,
      resource: lineage.resource,
      at: lineage.destroyed_at ?? Date.now(),
    };
    const id = artifactLifecycleKey(record);
    if (!replay(tx, options.idempotencyKey, id)) {
      if (!options.fence)
        throw new ArtifactVersionError(
          400,
          "missing-fence",
          "Destruction requires a lineage fence",
        );
      assertResourceFenceWithCanonical(
        tx,
        `artifact:${lineageId}`,
        options.fence,
        { requireLiveClaim: true },
      );
      assertIdle(tx, lineageId);
      tx.update(schema.artifactLineages)
        .set({ destroyed_at: record.at })
        .where(eq(schema.artifactLineages.id, lineageId))
        .run();
      tx.update(schema.artifactPointers)
        .set({ tombstoned: 1, tombstoned_at: record.at, content_inline: null })
        .where(
          and(
            eq(schema.artifactPointers.lineage_id, lineageId),
            eq(schema.artifactPointers.tombstoned, 0),
          ),
        )
        .run();
      tx.delete(schema.artifactSearchDocs)
        .where(
          inArray(
            schema.artifactSearchDocs.artifact_key,
            tx
              .select({ key: schema.artifactRevisions.r2_key })
              .from(schema.artifactRevisions)
              .where(eq(schema.artifactRevisions.lineage_id, lineageId)),
          ),
        )
        .run();
      if (lineage.destroyed_at == null)
        appendJournal(tx, {
          ...origin,
          kind: "artifact.tombstoned",
          resource: `artifact:${lineageId}`,
          fence: options.fence,
          data: { lineage_id: lineageId, group_destroyed: true },
        });
      enqueue(tx, record, options.idempotencyKey);
    }
    return {
      id,
      response: {
        ok: true as const,
        lineage_id: lineageId,
        destroyed_at: record.at,
      },
    };
  });
}

/** Snapshot the existing policy once; process a bounded page each invocation. */
export function backfillRetention(db: Db, limit = 100): number {
  return db.transaction((tx) => {
    let state = tx.select().from(schema.artifactRetentionState).get();
    if (!state) {
      const unassigned = tx
        .select({ key: schema.artifactRevisions.r2_key })
        .from(schema.artifactRevisions)
        .where(eq(schema.artifactRevisions.retention_assigned, 0))
        .get();
      if (!unassigned) return 0;
      const parsed = resolveCurrentSchema(tx);
      state = {
        id: 1,
        policy: JSON.stringify(
          Object.fromEntries(
            Object.entries(parsed?.artifacts ?? {}).map(([kind, value]) => [
              kind,
              value.retention_days,
            ]),
          ),
        ),
        cursor: null,
        complete: 0,
      };
      tx.insert(schema.artifactRetentionState).values(state).run();
    }
    const policy = JSON.parse(state.policy) as Record<string, number>;
    const rows = tx
      .select()
      .from(schema.artifactRevisions)
      .where(eq(schema.artifactRevisions.retention_assigned, 0))
      .orderBy(asc(schema.artifactRevisions.r2_key))
      .limit(limit)
      .all();
    for (const row of rows) {
      const pointer = ArtifactRevisionSchema.parse(JSON.parse(row.metadata));
      const days = policy[pointer.kind] ?? 0;
      pointer.expires_at =
        days > 0 ? pointer.produced_at + days * 86_400_000 : null;
      updateMetadata(tx, pointer);
      tx.update(schema.artifactRevisions)
        .set({ retention_assigned: 1 })
        .where(eq(schema.artifactRevisions.r2_key, row.r2_key))
        .run();
      tx.update(schema.artifactPointers)
        .set({ expires_at: pointer.expires_at })
        .where(eq(schema.artifactPointers.r2_key, row.r2_key))
        .run();
      enqueue(tx, recordFor(tx, pointer, "retention", Date.now()));
    }
    tx.update(schema.artifactRetentionState)
      .set({
        cursor: rows.at(-1)?.r2_key ?? state.cursor,
        complete: rows.length < limit ? 1 : 0,
      })
      .where(eq(schema.artifactRetentionState.id, 1))
      .run();
    return rows.length;
  });
}

export function prepareLifecycle(db: Db, limit = 100, now = Date.now()): void {
  backfillRetention(db, limit);
  const rows = db
    .select({
      key: schema.artifactRevisions.r2_key,
      metadata: schema.artifactRevisions.metadata,
      destroyed: schema.artifactLineages.destroyed_at,
    })
    .from(schema.artifactRevisions)
    .innerJoin(
      schema.artifactLineages,
      eq(schema.artifactLineages.id, schema.artifactRevisions.lineage_id),
    )
    .where(
      and(
        sql`json_extract(${schema.artifactRevisions.metadata}, '$.blob_deleted_at') IS NULL`,
        or(
          sql`${schema.artifactLineages.destroyed_at} IS NOT NULL`,
          sql`json_extract(${schema.artifactRevisions.metadata}, '$.tombstoned') = 1`,
          sql`(json_extract(${schema.artifactRevisions.metadata}, '$.expires_at') <= ${now} AND EXISTS (SELECT 1 FROM artifact_pointers AS newer WHERE newer.lineage_id = ${schema.artifactRevisions.lineage_id} AND newer.revision > ${schema.artifactRevisions.revision} AND newer.tombstoned = 0 AND newer.blob_deleted_at IS NULL))`,
        ),
        notExists(
          db
            .select({ id: schema.artifactRevisionOperations.id })
            .from(schema.artifactRevisionOperations)
            .where(
              and(
                eq(
                  schema.artifactRevisionOperations.lineage_id,
                  schema.artifactRevisions.lineage_id,
                ),
                inArray(schema.artifactRevisionOperations.state, [
                  "reserved",
                  "accepted",
                ]),
              ),
            ),
        ),
        notExists(
          db
            .select({ id: schema.artifactLifecycleOperations.id })
            .from(schema.artifactLifecycleOperations)
            .where(
              and(
                eq(
                  schema.artifactLifecycleOperations.id,
                  sql`${schema.artifactRevisions.r2_key} || '.retention.json'`,
                ),
                ne(schema.artifactLifecycleOperations.state, "done"),
              ),
            ),
        ),
        notExists(
          db
            .select({ id: schema.artifactLifecycleOperations.id })
            .from(schema.artifactLifecycleOperations)
            .where(
              eq(
                schema.artifactLifecycleOperations.id,
                sql`${schema.artifactRevisions.r2_key} || '.tombstone.json'`,
              ),
            ),
        ),
      ),
    )
    .orderBy(asc(schema.artifactRevisions.r2_key))
    .limit(limit)
    .all();
  let accepted = 0;
  for (const row of rows) {
    if (accepted >= limit) break;
    const pointer = ArtifactRevisionSchema.parse(JSON.parse(row.metadata));
    try {
      const reason =
        row.destroyed != null
          ? "destroy"
          : pointer.tombstoned
            ? "destroy"
            : "expired";
      if (acceptDeletion(db, row.key, {}, systemOrigin, reason, now))
        accepted++;
    } catch (error) {
      if (
        !(
          error instanceof ArtifactVersionError &&
          error.code === "artifact-lineage-busy"
        )
      )
        throw error;
    }
  }
}

export function hasLifecycleWork(db: Db): boolean {
  return Boolean(
    db
      .select()
      .from(schema.artifactLifecycleOperations)
      .where(ne(schema.artifactLifecycleOperations.state, "done"))
      .get() ||
      db
        .select()
        .from(schema.artifactRevisions)
        .where(eq(schema.artifactRevisions.retention_assigned, 0))
        .get() ||
      db
        .select()
        .from(schema.artifactRevisions)
        .innerJoin(
          schema.artifactLineages,
          eq(schema.artifactLineages.id, schema.artifactRevisions.lineage_id),
        )
        .where(
          and(
            sql`${schema.artifactLineages.destroyed_at} IS NOT NULL`,
            sql`json_extract(${schema.artifactRevisions.metadata}, '$.blob_deleted_at') IS NULL`,
          ),
        )
        .get(),
  );
}

/** The adapter must create immutable JSON records and compare existing content. */
export interface LifecycleStore {
  writeRecord(key: string, record: ArtifactLifecycleRecord): Promise<void>;
  deleteBlob(key: string): Promise<void>;
}

export async function publishLifecycleRecord(
  db: Db,
  store: LifecycleStore,
  id: string,
): Promise<void> {
  const op = db
    .select()
    .from(schema.artifactLifecycleOperations)
    .where(eq(schema.artifactLifecycleOperations.id, id))
    .get();
  if (!op || op.state !== "pending") return;
  const record = ArtifactLifecycleRecordSchema.parse(JSON.parse(op.record));
  await store.writeRecord(id, record);
  db.update(schema.artifactLifecycleOperations)
    .set({ state: record.type === "tombstone" ? "published" : "done" })
    .where(
      and(
        eq(schema.artifactLifecycleOperations.id, id),
        eq(schema.artifactLifecycleOperations.state, "pending"),
      ),
    )
    .run();
}

export async function drainLifecycle(
  db: Db,
  store: LifecycleStore,
  limit = 50,
  now = Date.now(),
) {
  prepareLifecycle(db, limit, now);
  const ops = db
    .select()
    .from(schema.artifactLifecycleOperations)
    .where(
      and(
        ne(schema.artifactLifecycleOperations.state, "done"),
        lte(schema.artifactLifecycleOperations.retry_at, now),
      ),
    )
    .orderBy(
      asc(schema.artifactLifecycleOperations.retry_at),
      asc(schema.artifactLifecycleOperations.id),
    )
    .limit(limit)
    .all();
  let deleted = 0;
  let errors = 0;
  for (const op of ops) {
    try {
      const record = ArtifactLifecycleRecordSchema.parse(JSON.parse(op.record));
      // A retirement record is durable before any member blob is deleted.
      if (
        record.type === "tombstone" &&
        isLineageDestroyed(db, record.lineage_id)
      ) {
        const group = { ...record, type: "destroy" as const };
        await publishLifecycleRecord(db, store, artifactLifecycleKey(group));
      }
      await publishLifecycleRecord(db, store, op.id);
      if (record.type !== "tombstone") continue;
      const key = required(record.pointer).r2_key;
      await store.deleteBlob(key);
      // Persist the confirmation timestamp before the external write, so retries
      // always compare identical immutable records, even after process death.
      const confirmationId = `${key}.deleted.json`;
      db.transaction((tx) => {
        const pointer = required(revisionMetadata(tx, key));
        enqueue(
          tx,
          recordFor(tx, { ...pointer, blob_deleted_at: now }, "deleted", now),
        );
      });
      await publishLifecycleRecord(db, store, confirmationId);
      const confirmation = required(
        db
          .select()
          .from(schema.artifactLifecycleOperations)
          .where(eq(schema.artifactLifecycleOperations.id, confirmationId))
          .get(),
      );
      const at = ArtifactLifecycleRecordSchema.parse(
        JSON.parse(confirmation.record),
      ).at;
      db.transaction((tx) => {
        const pointer = required(revisionMetadata(tx, key));
        updateMetadata(tx, { ...pointer, blob_deleted_at: at });
        tx.update(schema.artifactPointers)
          .set({ blob_deleted_at: at })
          .where(eq(schema.artifactPointers.r2_key, key))
          .run();
        tx.update(schema.artifactLifecycleOperations)
          .set({ state: "done" })
          .where(eq(schema.artifactLifecycleOperations.id, op.id))
          .run();
      });
      deleted++;
    } catch {
      errors++;
      db.update(schema.artifactLifecycleOperations)
        .set({
          attempts: op.attempts + 1,
          retry_at:
            now + Math.min(3_600_000, 5000 * 2 ** Math.min(op.attempts, 10)),
        })
        .where(eq(schema.artifactLifecycleOperations.id, op.id))
        .run();
    }
  }
  return { deleted, errors, pending: hasLifecycleWork(db) };
}

/** Replay monotonic lifecycle facts before importing the original commit. */
export function reconcileLifecycle(
  db: Db,
  input: unknown,
  projectId: string,
): void {
  const record = ArtifactLifecycleRecordSchema.parse(input);
  if (record.project_id !== projectId)
    throw new ArtifactVersionError(
      422,
      "invalid-lifecycle-record",
      "Wrong project",
    );
  const p = record.pointer;
  if (
    p &&
    (p.kind !== record.kind ||
      p.resource !== record.resource ||
      p.r2_key !==
        artifactRevisionKey(
          projectId,
          record.lineage_id,
          required(p.revision),
          p.sha256,
          p.mime_type,
        ))
  )
    throw new ArtifactVersionError(
      422,
      "invalid-lifecycle-record",
      "Wrong revision identity",
    );
  db.transaction((tx) => {
    const lineage = tx
      .select()
      .from(schema.artifactLineages)
      .where(eq(schema.artifactLineages.id, record.lineage_id))
      .get();
    if (
      lineage &&
      (lineage.project_id !== projectId ||
        lineage.kind !== record.kind ||
        lineage.resource !== record.resource)
    )
      throw new ArtifactVersionError(
        409,
        "lineage-conflict",
        "Lifecycle identity conflicts",
      );
    tx.insert(schema.artifactLineages)
      .values({
        id: record.lineage_id,
        project_id: projectId,
        kind: record.kind,
        resource: record.resource,
      })
      .onConflictDoNothing()
      .run();
    if (record.type === "destroy") {
      tx.update(schema.artifactLineages)
        .set({ destroyed_at: lineage?.destroyed_at ?? record.at })
        .where(eq(schema.artifactLineages.id, record.lineage_id))
        .run();
      tx.update(schema.artifactPointers)
        .set({ tombstoned: 1, tombstoned_at: record.at, content_inline: null })
        .where(
          and(
            eq(schema.artifactPointers.lineage_id, record.lineage_id),
            eq(schema.artifactPointers.tombstoned, 0),
          ),
        )
        .run();
      tx.delete(schema.artifactSearchDocs)
        .where(
          inArray(
            schema.artifactSearchDocs.artifact_key,
            tx
              .select({ key: schema.artifactPointers.r2_key })
              .from(schema.artifactPointers)
              .where(eq(schema.artifactPointers.lineage_id, record.lineage_id)),
          ),
        )
        .run();
    } else if (p) {
      saveRevision(tx, p, true);
      const current = required(revisionMetadata(tx, p.r2_key));
      if (record.type === "retention") current.expires_at = p.expires_at;
      else {
        current.tombstoned = 1;
        current.tombstoned_at ??= p.tombstoned_at ?? record.at;
        if (record.type === "deleted") current.blob_deleted_at ??= record.at;
      }
      updateMetadata(tx, current);
      tx.update(schema.artifactRevisions)
        .set({ retention_assigned: 1 })
        .where(eq(schema.artifactRevisions.r2_key, p.r2_key))
        .run();
      tx.update(schema.artifactPointers)
        .set({
          expires_at: current.expires_at,
          tombstoned: current.tombstoned,
          tombstoned_at: current.tombstoned_at,
          blob_deleted_at: current.blob_deleted_at,
        })
        .where(eq(schema.artifactPointers.r2_key, p.r2_key))
        .run();
      if (current.tombstoned)
        tx.delete(schema.artifactSearchDocs)
          .where(eq(schema.artifactSearchDocs.artifact_key, p.r2_key))
          .run();
    }
    const id = enqueue(tx, record);
    tx.update(schema.artifactLifecycleOperations)
      .set({ state: record.type === "tombstone" ? "published" : "done" })
      .where(eq(schema.artifactLifecycleOperations.id, id))
      .run();
  });
}

export function syncPointerLifecycle(db: Db, key: string): void {
  const pointer = revisionMetadata(db, key);
  if (!pointer) return;
  const row = db
    .select()
    .from(schema.artifactPointers)
    .where(eq(schema.artifactPointers.r2_key, key))
    .get();
  if (row)
    updateMetadata(db, {
      ...pointer,
      tombstoned: row.tombstoned,
      tombstoned_at: row.tombstoned_at,
      blob_deleted_at: row.blob_deleted_at,
    });
}

function required<T>(value: T | null | undefined): T {
  if (value == null)
    throw new ArtifactVersionError(
      500,
      "invalid-lifecycle-state",
      "Lifecycle metadata is missing",
    );
  return value;
}
