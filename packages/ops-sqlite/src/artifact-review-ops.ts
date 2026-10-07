import {
  type ArtifactProvenance,
  ArtifactProvenanceSchema,
  ArtifactReviewEventSchema,
  type ArtifactReviewRequest,
  ArtifactReviewRequestSchema,
  type ArtifactReviewSummary,
  type ArtifactReviewsQuery,
  ArtifactReviewsQuerySchema,
  ArtifactRevisionSchema,
} from "@tila/schemas";
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { resolveCurrentSchema } from "./constraint-ops";
import { type RequestOrigin, appendJournal } from "./journal-ops";
import * as schema from "./schema";

type Db = BaseSQLiteDatabase<"sync", unknown, typeof schema>;

export class ArtifactReviewError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export function provenanceFromOrigin(
  origin: RequestOrigin,
  now: number,
): ArtifactProvenance {
  return ArtifactProvenanceSchema.parse({
    principal_id: origin.principalId,
    participant_id: origin.participantId,
    created_at: now,
    environment: origin.environment,
    client_name: origin.environment.client_name ?? origin.source ?? null,
    client_version:
      origin.environment.client_version ?? origin.sourceVersion ?? null,
  });
}

export function reviewSummary(
  event: typeof schema.artifactReviews.$inferSelect | null,
): ArtifactReviewSummary {
  const latest = event ? ArtifactReviewEventSchema.parse(event) : null;
  return {
    state:
      latest && latest.decision !== "revoked" ? latest.decision : "unreviewed",
    review_revision: latest?.review_revision ?? 0,
    latest,
  };
}

/** Batch hydration avoids one query per search/list result. */
export function artifactTrustByKeys(db: Db, keys: string[]) {
  const result = new Map<
    string,
    {
      provenance: ArtifactProvenance | null;
      revision_creation: ArtifactProvenance | null;
      review: ArtifactReviewSummary;
    }
  >();
  // SQLite variable limits also apply to large grep candidate sets.
  for (let offset = 0; offset < keys.length; offset += 200) {
    const chunk = keys.slice(offset, offset + 200);
    const pointers = db
      .select({
        key: schema.artifactPointers.r2_key,
        provenance: schema.artifactPointers.provenance,
        revision_creation: schema.artifactPointers.revision_creation,
      })
      .from(schema.artifactPointers)
      .where(inArray(schema.artifactPointers.r2_key, chunk))
      .all();
    for (const p of pointers)
      result.set(p.key, {
        provenance: p.provenance,
        revision_creation: p.revision_creation,
        review: reviewSummary(null),
      });
    const archives = db
      .select()
      .from(schema.artifactRevisions)
      .where(inArray(schema.artifactRevisions.r2_key, chunk))
      .all();
    for (const archive of archives) {
      if (result.has(archive.r2_key)) continue;
      const p = ArtifactRevisionSchema.parse(JSON.parse(archive.metadata));
      result.set(archive.r2_key, {
        provenance: p.provenance ?? null,
        revision_creation: p.revision_creation ?? null,
        review: reviewSummary(null),
      });
    }
    const reviews = db
      .select()
      .from(schema.artifactReviews)
      .where(
        and(
          inArray(schema.artifactReviews.artifact_key, chunk),
          sql`${schema.artifactReviews.review_revision} = (SELECT MAX(r.review_revision) FROM artifact_reviews r WHERE r.artifact_key = ${schema.artifactReviews.artifact_key})`,
        ),
      )
      .all();
    for (const review of reviews) {
      const item = result.get(review.artifact_key);
      if (item) item.review = reviewSummary(review);
    }
  }
  return result;
}

export function enrichArtifacts<T extends { r2_key: string }>(
  db: Db,
  rows: T[],
) {
  const trust = artifactTrustByKeys(
    db,
    rows.map((row) => row.r2_key),
  );
  return rows.map((row) => ({
    ...row,
    ...(trust.get(row.r2_key) ?? {
      provenance: null,
      revision_creation: null,
      review: reviewSummary(null),
    }),
  }));
}

function assertArtifact(db: Db, key: string) {
  const pointer = db
    .select()
    .from(schema.artifactPointers)
    .where(eq(schema.artifactPointers.r2_key, key))
    .get();
  const archive = pointer
    ? null
    : db
        .select()
        .from(schema.artifactRevisions)
        .where(eq(schema.artifactRevisions.r2_key, key))
        .get();
  if (!pointer && !archive)
    throw new ArtifactReviewError(404, "not-found", "Artifact not found");
  return pointer;
}

export function listArtifactReviews(
  db: Db,
  key: string,
  query: ArtifactReviewsQuery = {},
) {
  assertArtifact(db, key);
  const opts = ArtifactReviewsQuerySchema.parse(query);
  const rows = db
    .select()
    .from(schema.artifactReviews)
    .where(
      and(
        eq(schema.artifactReviews.artifact_key, key),
        opts.before_revision === undefined
          ? undefined
          : lt(schema.artifactReviews.review_revision, opts.before_revision),
      ),
    )
    .orderBy(desc(schema.artifactReviews.review_revision))
    .limit(opts.limit + 1)
    .all();
  const more = rows.length > opts.limit;
  if (more) rows.pop();
  return {
    ok: true as const,
    items: rows.map((row) => ArtifactReviewEventSchema.parse(row)),
    next_revision: more ? (rows.at(-1)?.review_revision ?? null) : null,
  };
}

export function reviewArtifact(
  db: Db,
  key: string,
  input: ArtifactReviewRequest,
  origin: RequestOrigin,
  operationId: string,
) {
  const request = ArtifactReviewRequestSchema.parse(input);
  const requestJson = JSON.stringify([
    key,
    request.expected_review_revision,
    request.decision,
    request.reason ?? null,
  ]);
  return db.transaction((tx) => {
    assertArtifact(tx, key);
    const replay = tx
      .select()
      .from(schema.artifactReviews)
      .where(eq(schema.artifactReviews.operation_id, operationId))
      .get();
    if (replay) {
      if (
        replay.principal_id !== origin.principalId ||
        replay.request_json !== requestJson
      )
        throw new ArtifactReviewError(
          422,
          "idempotency-key-conflict",
          "Idempotency key reused with different input",
        );
      return { ok: true as const, review: reviewSummary(replay) };
    }
    const latest = tx
      .select()
      .from(schema.artifactReviews)
      .where(eq(schema.artifactReviews.artifact_key, key))
      .orderBy(desc(schema.artifactReviews.review_revision))
      .get();
    if ((latest?.review_revision ?? 0) !== request.expected_review_revision)
      throw new ArtifactReviewError(
        409,
        "review-conflict",
        "Review changed; read the current review before retrying",
      );
    const event = {
      artifact_key: key,
      review_revision: request.expected_review_revision + 1,
      principal_id: origin.principalId,
      participant_id: origin.participantId,
      created_at: Date.now(),
      decision: request.decision,
      reason: request.reason ?? null,
      operation_id: operationId,
      request_json: requestJson,
    };
    tx.insert(schema.artifactReviews).values(event).run();
    appendJournal(tx, {
      ...origin,
      kind: "artifact.reviewed",
      resource: key,
      data: ArtifactReviewEventSchema.parse(event),
    });
    return { ok: true as const, review: reviewSummary(event) };
  });
}

/** Call inside the task transaction, only on entry into a status. */
export function assertArtifactReviewPolicy(
  db: Db,
  entityId: string,
  type: string,
  status: unknown,
) {
  if (typeof status !== "string") return;
  const slots =
    resolveCurrentSchema(db)?.work_units[type]?.references?.filter((slot) =>
      slot.require_trusted_for_statuses?.includes(status),
    ) ?? [];
  const failures: {
    slot: string;
    artifacts: { key: string; state: string }[];
  }[] = [];
  const now = Date.now();
  for (const slot of slots) {
    const refs = db
      .select()
      .from(schema.entityArtifactReferences)
      .where(
        and(
          eq(schema.entityArtifactReferences.entity_id, entityId),
          eq(schema.entityArtifactReferences.slot, slot.name),
        ),
      )
      .all();
    const keys = refs.map((ref) => ref.artifact_key);
    const trust = artifactTrustByKeys(db, keys);
    const pointers = keys.length
      ? db
          .select()
          .from(schema.artifactPointers)
          .where(inArray(schema.artifactPointers.r2_key, keys))
          .all()
      : [];
    const bad = keys.flatMap((key) => {
      const p = pointers.find((p) => p.r2_key === key);
      const state =
        !p ||
        p.tombstoned ||
        p.blob_deleted_at !== null ||
        (p.expires_at !== null && p.expires_at <= now)
          ? "unavailable"
          : (trust.get(key)?.review.state ?? "unreviewed");
      return state === "trusted" ? [] : [{ key, state }];
    });
    if (!keys.length || bad.length)
      failures.push({ slot: slot.name, artifacts: bad });
  }
  if (failures.length)
    throw new ArtifactReviewError(
      422,
      "artifact-review-required",
      "Task state requires trusted artifacts in the configured reference slots",
      { slots: failures },
    );
}
