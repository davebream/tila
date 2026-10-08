import {
  type ArtifactCommitRecord,
  ArtifactCommitRecordSchema,
  type ArtifactHistoryQuery,
  ArtifactHistoryQuerySchema,
  type ArtifactHistoryResponse,
  ArtifactLineageIdSchema,
  type ArtifactRevision,
  type ArtifactRevisionResponse,
  ArtifactRevisionSchema,
  TagsSchema,
  artifactRevisionKey,
} from "@tila/schemas";
import { and, desc, eq, inArray, isNull, lt, lte, sql } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { enrichArtifacts, provenanceFromOrigin } from "./artifact-review-ops";
import {
  assertResourceFence,
  assertResourceFenceWithCanonical,
} from "./fence-ops";
import { type RequestOrigin, appendJournal } from "./journal-ops";
import * as schema from "./schema";

type Db = BaseSQLiteDatabase<"sync", unknown, typeof schema>;
export { ArtifactVersionError } from "./artifact-version-error";
import * as lifecycle from "./artifact-lifecycle-ops";
import { ArtifactVersionError } from "./artifact-version-error";
import {
  getArtifactKindRetention,
  resolveCurrentSchema,
} from "./constraint-ops";
export type RevisionOperation =
  typeof schema.artifactRevisionOperations.$inferSelect;
export interface ReserveArtifactRevision {
  project_id: string;
  operation_id: string;
  request_hash: string;
  lineage_id: string;
  lineage_fence: number;
  kind: string;
  resource: string | null;
  sha256: string;
  bytes: number;
  mime_type: string;
  fence: number | null;
  tags?: string[];
  restored_from?: string;
  adopt?: boolean;
  search_text?: { title: string | null; body_text: string } | null;
}

export function getArtifactMeta(db: Db, key: string): ArtifactRevision {
  const archived = lifecycle.revisionMetadata(db, key);
  if (archived)
    return ArtifactRevisionSchema.parse(enrichArtifacts(db, [archived])[0]);
  const row = db
    .select()
    .from(schema.artifactPointers)
    .where(eq(schema.artifactPointers.r2_key, key))
    .get();
  if (!row)
    throw new ArtifactVersionError(
      404,
      "not-found",
      `Artifact ${key} not found`,
    );
  const tags = db
    .select()
    .from(schema.artifactTags)
    .where(eq(schema.artifactTags.artifact_key, key))
    .all()
    .map((t) => t.tag);
  return ArtifactRevisionSchema.parse({
    ...enrichArtifacts(db, [row])[0],
    tags,
  });
}

export function assertRestorable(db: Db, key: string): ArtifactRevision {
  const pointer = getArtifactMeta(db, key);
  if (pointer.tombstoned || pointer.blob_deleted_at != null)
    throw new ArtifactVersionError(
      410,
      "artifact-unavailable",
      "Artifact content is no longer available",
    );
  return pointer;
}

export function getArtifactLineageHead(
  db: Db,
  lineage: string,
): ArtifactRevision | null {
  if (lifecycle.isLineageDestroyed(db, lineage)) return null;
  const row = db
    .select({ key: schema.artifactPointers.r2_key })
    .from(schema.artifactPointers)
    .where(
      and(
        eq(schema.artifactPointers.lineage_id, lineage),
        eq(schema.artifactPointers.tombstoned, 0),
        isNull(schema.artifactPointers.blob_deleted_at),
      ),
    )
    .orderBy(desc(schema.artifactPointers.revision))
    .get();
  return row ? getArtifactMeta(db, row.key) : null;
}

export function getRevisionOperation(
  db: Db,
  id: string,
): RevisionOperation | undefined {
  return db
    .select()
    .from(schema.artifactRevisionOperations)
    .where(eq(schema.artifactRevisionOperations.id, id))
    .get();
}
export function revisionRecord(
  operation: RevisionOperation,
): ArtifactCommitRecord {
  return ArtifactCommitRecordSchema.parse(JSON.parse(operation.record));
}
export function revisionResponse(
  pointer: ArtifactRevision,
  deduplicated = false,
): ArtifactRevisionResponse {
  return {
    ok: true,
    key: pointer.r2_key,
    bytes: pointer.bytes,
    deduplicated,
    pointer,
    restored_from: pointer.restored_from,
  };
}

function validateFences(db: Db, record: ArtifactCommitRecord): void {
  // The generic resource helper's live-claim option applies only to entities.
  // Use the exact canonical helper so artifact claims also expire fail-closed.
  assertResourceFenceWithCanonical(
    db,
    `artifact:${record.pointer.lineage_id}`,
    record.lineage_fence,
    { requireLiveClaim: true },
  );
  if (!record.pointer.restored_from && record.pointer.resource !== null) {
    if (record.pointer.fence === null)
      throw new ArtifactVersionError(
        400,
        "missing-fence",
        "Produced artifact requires a resource fence",
      );
    assertResourceFence(db, record.pointer.resource, record.pointer.fence, {
      requireLiveClaim: true,
    });
  }
}

export function reserveArtifactRevision(
  db: Db,
  input: ReserveArtifactRevision,
  origin: RequestOrigin,
): { operation?: RevisionOperation; duplicate?: ArtifactRevision } {
  ArtifactLineageIdSchema.parse(input.lineage_id);
  const tags = TagsSchema.parse(input.tags ?? []);
  return db.transaction((tx) => {
    const replay = getRevisionOperation(tx, input.operation_id);
    if (replay) {
      if (replay.request_hash !== input.request_hash)
        throw new ArtifactVersionError(
          422,
          "idempotency-key-conflict",
          "Idempotency key reused with different input",
        );
      if (replay.state === "aborted")
        throw new ArtifactVersionError(
          409,
          "artifact-operation-aborted",
          "This operation was rejected; retry with a new idempotency key",
        );
      return { operation: replay };
    }
    const lineage = tx
      .select()
      .from(schema.artifactLineages)
      .where(eq(schema.artifactLineages.id, input.lineage_id))
      .get();
    if (
      lineage &&
      (lineage.project_id !== input.project_id ||
        lineage.kind !== input.kind ||
        lineage.resource !== input.resource ||
        input.adopt)
    ) {
      throw new ArtifactVersionError(
        409,
        "lineage-conflict",
        "Lineage already exists with incompatible identity or cannot be adopted into",
      );
    }
    lifecycle.assertLineageWritable(tx, input.lineage_id);
    const revision = lineage?.next_revision ?? 1;
    const producedAt = Date.now();
    const currentSchema = resolveCurrentSchema(tx);
    const retention = currentSchema
      ? getArtifactKindRetention(currentSchema, input.kind)
      : 0;
    const pointer: ArtifactCommitRecord["pointer"] = {
      r2_key: artifactRevisionKey(
        input.project_id,
        input.lineage_id,
        revision,
        input.sha256,
        input.mime_type,
      ),
      lineage_id: input.lineage_id,
      revision,
      restored_from: input.restored_from ?? null,
      resource: input.resource,
      kind: input.kind,
      sha256: input.sha256,
      bytes: input.bytes,
      fence: input.fence,
      mime_type: input.mime_type,
      produced_at: producedAt,
      produced_by: origin.actor,
      provenance: input.restored_from
        ? (getArtifactMeta(tx, input.restored_from).provenance ?? null)
        : provenanceFromOrigin(origin, producedAt),
      revision_creation: provenanceFromOrigin(origin, producedAt),
      expires_at: retention > 0 ? producedAt + retention * 86_400_000 : null,
      tombstoned: 0,
      tombstoned_at: null,
      blob_deleted_at: null,
      tags,
    };
    const record = ArtifactCommitRecordSchema.parse({
      format: "tila-artifact-revision-v1",
      retention_assigned: true,
      project_id: input.project_id,
      operation_id: input.operation_id,
      request_hash: input.request_hash,
      pointer,
      lineage_fence: input.lineage_fence,
      origin,
    });
    validateFences(tx, record);
    if (input.restored_from) {
      const source = assertRestorable(tx, input.restored_from);
      if (
        source.kind !== input.kind ||
        source.resource !== input.resource ||
        source.sha256 !== input.sha256 ||
        source.bytes !== input.bytes ||
        source.mime_type !== input.mime_type ||
        (source.lineage_id !== null &&
          source.lineage_id !== input.lineage_id) ||
        (source.lineage_id === null && !input.adopt)
      ) {
        throw new ArtifactVersionError(
          409,
          "lineage-conflict",
          "Restore must preserve the source identity",
        );
      }
    }
    const pending = tx
      .select()
      .from(schema.artifactRevisionOperations)
      .where(
        and(
          eq(schema.artifactRevisionOperations.lineage_id, input.lineage_id),
          inArray(schema.artifactRevisionOperations.state, [
            "reserved",
            "accepted",
          ]),
        ),
      )
      .all();
    for (const op of pending) {
      if (op.state === "reserved") {
        const prior = revisionRecord(op);
        // A new lease can discard an unfinished reservation. Never discard an
        // accepted commit: it must finish publication, even after lease expiry.
        if (prior.lineage_fence !== input.lineage_fence) {
          tx.update(schema.artifactRevisionOperations)
            .set({ state: "aborted" })
            .where(eq(schema.artifactRevisionOperations.id, op.id))
            .run();
          continue;
        }
      }
      throw new ArtifactVersionError(
        409,
        "artifact-lineage-busy",
        "A revision is still being published; retry",
        true,
      );
    }
    if (!input.restored_from) {
      const duplicate = tx
        .select()
        .from(schema.artifactPointers)
        .where(
          and(
            eq(schema.artifactPointers.lineage_id, input.lineage_id),
            eq(schema.artifactPointers.sha256, input.sha256),
            isNull(schema.artifactPointers.blob_deleted_at),
            eq(schema.artifactPointers.tombstoned, 0),
          ),
        )
        .orderBy(desc(schema.artifactPointers.revision))
        .get();
      if (duplicate) {
        const existingPointer = getArtifactMeta(tx, duplicate.r2_key);
        // A deduplicated request is still an idempotent result: replay it even
        // if a subsequent restore creates a newer revision with the same hash.
        const receipt = ArtifactCommitRecordSchema.parse({
          ...record,
          pointer: existingPointer,
          deduplicated: true,
        });
        tx.insert(schema.artifactRevisionOperations)
          .values({
            id: input.operation_id,
            lineage_id: input.lineage_id,
            request_hash: input.request_hash,
            state: "published",
            record: JSON.stringify(receipt),
            search_text: null,
            created_at: Date.now(),
          })
          .run();
        return { duplicate: existingPointer };
      }
    }
    if (!lineage)
      tx.insert(schema.artifactLineages)
        .values({
          id: input.lineage_id,
          project_id: input.project_id,
          kind: input.kind,
          resource: input.resource,
          next_revision: 2,
        })
        .run();
    else
      tx.update(schema.artifactLineages)
        .set({ next_revision: revision + 1 })
        .where(eq(schema.artifactLineages.id, input.lineage_id))
        .run();
    const sourceSearch = input.restored_from
      ? tx
          .select()
          .from(schema.artifactSearchDocs)
          .where(
            eq(schema.artifactSearchDocs.artifact_key, input.restored_from),
          )
          .get()
      : null;
    const searchText =
      input.search_text ??
      (sourceSearch
        ? { title: sourceSearch.title, body_text: sourceSearch.body_text }
        : null);
    const operation: RevisionOperation = {
      id: input.operation_id,
      lineage_id: input.lineage_id,
      request_hash: input.request_hash,
      state: "reserved",
      record: JSON.stringify(record),
      search_text: searchText ? JSON.stringify(searchText) : null,
      created_at: Date.now(),
    };
    tx.insert(schema.artifactRevisionOperations).values(operation).run();
    return { operation };
  });
}

export function acceptArtifactRevision(db: Db, id: string): RevisionOperation {
  return db.transaction((tx) => {
    const op = getRevisionOperation(tx, id);
    if (!op || op.state === "aborted")
      throw new ArtifactVersionError(
        409,
        "artifact-operation-aborted",
        "Revision reservation is unavailable",
      );
    if (op.state !== "reserved") return op;
    const record = revisionRecord(op);
    validateFences(tx, record);
    if (record.pointer.restored_from)
      assertRestorable(tx, record.pointer.restored_from);
    tx.update(schema.artifactRevisionOperations)
      .set({ state: "accepted" })
      .where(eq(schema.artifactRevisionOperations.id, id))
      .run();
    appendJournal(tx, {
      ...record.origin,
      kind: "artifact.produced",
      resource: `artifact:${record.pointer.lineage_id}`,
      fence: record.lineage_fence,
      data: {
        r2_key: record.pointer.r2_key,
        sha256: record.pointer.sha256,
        lineage_id: record.pointer.lineage_id,
        revision: record.pointer.revision,
        restored_from: record.pointer.restored_from,
      },
    });
    return { ...op, state: "accepted" };
  });
}

export function abortArtifactRevision(db: Db, id: string): void {
  db.update(schema.artifactRevisionOperations)
    .set({ state: "aborted" })
    .where(
      and(
        eq(schema.artifactRevisionOperations.id, id),
        eq(schema.artifactRevisionOperations.state, "reserved"),
      ),
    )
    .run();
}

function insertPublishedPointer(
  db: Db,
  record: ArtifactCommitRecord,
  searchText: string | null,
): void {
  const pointer = { ...record.pointer };
  // Old restore/dedup records identify the request actor, not the producer.
  const fallback =
    !record.deduplicated && !pointer.restored_from
      ? provenanceFromOrigin(record.origin, pointer.produced_at)
      : null;
  pointer.provenance =
    pointer.provenance === undefined ? fallback : pointer.provenance;
  pointer.revision_creation =
    pointer.revision_creation === undefined && !record.deduplicated
      ? provenanceFromOrigin(record.origin, pointer.produced_at)
      : (pointer.revision_creation ?? null);
  lifecycle.saveRevision(db, pointer, record.retention_assigned === true);
  const effective = lifecycle.revisionMetadata(db, record.pointer.r2_key);
  if (!effective)
    throw new Error("Missing revision metadata after publication");
  if (
    effective.tombstoned ||
    effective.blob_deleted_at != null ||
    lifecycle.isLineageDestroyed(db, record.pointer.lineage_id)
  )
    return;
  const { tags, ...effectivePointer } = effective;
  db.insert(schema.artifactPointers)
    .values(effectivePointer)
    .onConflictDoNothing()
    .run();
  for (const tag of tags)
    db.insert(schema.artifactTags)
      .values({ artifact_key: pointer.r2_key, tag })
      .onConflictDoNothing()
      .run();
  if (searchText) {
    const text = JSON.parse(searchText) as {
      title: string | null;
      body_text: string;
    };
    db.insert(schema.artifactSearchDocs)
      .values({
        artifact_key: pointer.r2_key,
        kind: pointer.kind,
        mime_type: pointer.mime_type,
        resource: pointer.resource,
        title: text.title,
        body_text: text.body_text,
        indexed_at: Date.now(),
        source_sha256: pointer.sha256,
        tombstoned: 0,
      })
      .onConflictDoNothing()
      .run();
  }
}

export function publishArtifactRevision(
  db: Db,
  id: string,
): ArtifactRevisionResponse {
  return db.transaction((tx) => {
    const op = getRevisionOperation(tx, id);
    if (!op || !["accepted", "published"].includes(op.state))
      throw new ArtifactVersionError(
        409,
        "artifact-not-accepted",
        "Revision has no accepted commit",
      );
    const record = revisionRecord(op);
    if (op.state !== "published") {
      insertPublishedPointer(tx, record, op.search_text);
      tx.update(schema.artifactRevisionOperations)
        .set({ state: "published" })
        .where(eq(schema.artifactRevisionOperations.id, id))
        .run();
    }
    return revisionResponse(
      getArtifactMeta(tx, record.pointer.r2_key),
      record.deduplicated ?? false,
    );
  });
}

export function listPendingArtifactCommits(
  db: Db,
  limit = 50,
): RevisionOperation[] {
  return db
    .select()
    .from(schema.artifactRevisionOperations)
    .where(eq(schema.artifactRevisionOperations.state, "accepted"))
    .limit(limit)
    .all();
}

export function reconcileArtifactCommit(
  db: Db,
  input: unknown,
  projectId: string,
  searchText: string | null = null,
): void {
  const record = ArtifactCommitRecordSchema.parse(input);
  const p = record.pointer;
  if (
    record.project_id !== projectId ||
    p.r2_key !==
      artifactRevisionKey(
        projectId,
        p.lineage_id,
        p.revision,
        p.sha256,
        p.mime_type,
      )
  )
    throw new ArtifactVersionError(
      422,
      "invalid-commit-record",
      "Commit record does not belong to this project/key",
    );
  db.transaction((tx) => {
    const existing = getRevisionOperation(tx, record.operation_id);
    if (
      existing &&
      (existing.state === "aborted" ||
        existing.request_hash !== record.request_hash ||
        existing.record !== JSON.stringify(record))
    )
      throw new ArtifactVersionError(
        409,
        "commit-conflict",
        "Recovery record conflicts with local operation",
      );
    const lineage = tx
      .select()
      .from(schema.artifactLineages)
      .where(eq(schema.artifactLineages.id, p.lineage_id))
      .get();
    if (
      lineage &&
      (lineage.project_id !== projectId ||
        lineage.kind !== p.kind ||
        lineage.resource !== p.resource)
    )
      throw new ArtifactVersionError(
        409,
        "lineage-conflict",
        "Recovery lineage identity conflicts",
      );
    tx.insert(schema.artifactLineages)
      .values({
        id: p.lineage_id,
        project_id: projectId,
        kind: p.kind,
        resource: p.resource,
        next_revision: p.revision + 1,
      })
      .onConflictDoUpdate({
        target: schema.artifactLineages.id,
        set: {
          next_revision: Math.max(lineage?.next_revision ?? 1, p.revision + 1),
        },
      })
      .run();
    if (!existing) {
      tx.insert(schema.artifactRevisionOperations)
        .values({
          id: record.operation_id,
          lineage_id: p.lineage_id,
          request_hash: record.request_hash,
          state: "accepted",
          record: JSON.stringify(record),
          search_text: searchText,
          created_at: p.produced_at,
        })
        .run();
      appendJournal(tx, {
        ...record.origin,
        kind: "artifact.reconciled",
        resource: `artifact:${p.lineage_id}`,
        fence: record.lineage_fence,
        data: {
          r2_key: p.r2_key,
          sha256: p.sha256,
          lineage_id: p.lineage_id,
          revision: p.revision,
          restored_from: p.restored_from,
        },
      });
    } else if (existing.state === "reserved") {
      // The SQLite snapshot may predate acceptance. The durable commit record
      // proves acceptance and is the recovery authority, not today's fence.
      tx.update(schema.artifactRevisionOperations)
        .set({
          state: "accepted",
          search_text: searchText ?? existing.search_text,
        })
        .where(eq(schema.artifactRevisionOperations.id, existing.id))
        .run();
      appendJournal(tx, {
        ...record.origin,
        kind: "artifact.reconciled",
        resource: `artifact:${p.lineage_id}`,
        fence: record.lineage_fence,
        data: {
          r2_key: p.r2_key,
          sha256: p.sha256,
          lineage_id: p.lineage_id,
          revision: p.revision,
          restored_from: p.restored_from,
        },
      });
    }
    publishArtifactRevision(tx, record.operation_id);
  });
}

export function listArtifactHistory(
  db: Db,
  key: string,
  options: ArtifactHistoryQuery = {},
): ArtifactHistoryResponse {
  const opts = ArtifactHistoryQuerySchema.parse(options);
  const limit = Math.min(200, Math.max(1, opts.limit ?? 20));
  const anchor = getArtifactMeta(db, key);
  if (!anchor.lineage_id) {
    if (opts.cursor)
      throw new ArtifactVersionError(
        400,
        "invalid-cursor",
        "Legacy artifact history has no cursor",
      );
    return {
      ok: true,
      items: [anchor],
      meta: { total: 1, limit, next_cursor: null },
    };
  }
  const base = eq(schema.artifactRevisions.lineage_id, anchor.lineage_id);
  let ceiling =
    db
      .select({ revision: schema.artifactRevisions.revision })
      .from(schema.artifactRevisions)
      .where(base)
      .orderBy(desc(schema.artifactRevisions.revision))
      .get()?.revision ?? 0;
  let before = ceiling + 1;
  if (opts.cursor) {
    try {
      const cursor = JSON.parse(atob(opts.cursor));
      if (
        cursor.v !== 1 ||
        cursor.lineage !== anchor.lineage_id ||
        !Number.isSafeInteger(cursor.ceiling) ||
        !Number.isSafeInteger(cursor.before) ||
        cursor.ceiling < 1 ||
        cursor.before < 1 ||
        cursor.before > cursor.ceiling + 1
      )
        throw new Error();
      ceiling = cursor.ceiling;
      before = cursor.before;
    } catch {
      throw new ArtifactVersionError(
        400,
        "invalid-cursor",
        "Cursor is malformed or belongs to another lineage",
      );
    }
  }
  const total =
    db
      .select({ count: sql<number>`count(*)` })
      .from(schema.artifactRevisions)
      .where(and(base, lte(schema.artifactRevisions.revision, ceiling)))
      .get()?.count ?? 0;
  const rows = db
    .select({
      key: schema.artifactRevisions.r2_key,
      revision: schema.artifactRevisions.revision,
    })
    .from(schema.artifactRevisions)
    .where(
      and(
        base,
        lte(schema.artifactRevisions.revision, ceiling),
        lt(schema.artifactRevisions.revision, before),
      ),
    )
    .orderBy(desc(schema.artifactRevisions.revision))
    .limit(limit + 1)
    .all();
  const page = rows.slice(0, limit);
  const next_cursor =
    rows.length > limit
      ? btoa(
          JSON.stringify({
            v: 1,
            lineage: anchor.lineage_id,
            ceiling,
            before: page[page.length - 1].revision,
          }),
        )
      : null;
  return {
    ok: true,
    items: page.map((row) => getArtifactMeta(db, row.key)),
    meta: { total, limit, next_cursor },
  };
}
