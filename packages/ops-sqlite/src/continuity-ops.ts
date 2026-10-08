import {
  ContinuityError,
  type ReentrySnapshot,
  type ReplaySnapshot,
  continuityJson,
} from "@tila/core";
import {
  type Handoff,
  type HandoffCreateRequest,
  HandoffCreateRequestSchema,
  type HandoffListRequest,
  HandoffListRequestSchema,
  type HandoffListResponse,
  HandoffSchema,
  type IdentityContext,
  JournalAcknowledgeRequestSchema,
  type JournalCursor,
  type JournalReplayRequest,
  JournalReplayRequestSchema,
  type ReentryRequest,
  ReentryRequestSchema,
} from "@tila/schemas";
import { and, desc, eq, gt, inArray, lt, lte, max } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { listClaims } from "./coordination-ops";
import { getArchiveWatermark } from "./journal-archive-ops";
import { appendJournal } from "./journal-ops";
import * as schema from "./schema";
import { inbox } from "./signal-ops";
import { getSummary } from "./summary-ops";

type Db = BaseSQLiteDatabase<"sync", unknown, typeof schema>;
const owner = (identity: IdentityContext) =>
  and(
    eq(schema.journalCursors.principal_id, identity.principal_id),
    eq(schema.journalCursors.participant_id, identity.participant_id),
  );
export function highSequence(db: Db): number {
  return Math.max(
    db
      .select({ seq: max(schema.journal.seq) })
      .from(schema.journal)
      .get()?.seq ?? 0,
    getArchiveWatermark(db)?.lastArchivedSeq ?? 0,
  );
}
export function getCursor(db: Db, identity: IdentityContext): JournalCursor {
  const row = db
    .select()
    .from(schema.journalCursors)
    .where(owner(identity))
    .get();
  return { seq: row?.seq ?? 0, updated_at: row?.updated_at ?? null };
}
export function acknowledge(
  db: Db,
  identity: IdentityContext,
  input: { seq: number },
): JournalCursor {
  const { seq } = JournalAcknowledgeRequestSchema.parse(input);
  return db.transaction((tx) => {
    if (seq > highSequence(tx))
      throw new ContinuityError(
        "invalid-cursor",
        "Cannot acknowledge a future journal sequence",
      );
    tx.insert(schema.journalCursors)
      .values({ ...identity, seq, updated_at: Date.now() })
      .onConflictDoUpdate({
        target: [
          schema.journalCursors.principal_id,
          schema.journalCursors.participant_id,
        ],
        set: { seq, updated_at: Date.now() },
        setWhere: lt(schema.journalCursors.seq, seq),
      })
      .run();
    return getCursor(tx, identity);
  });
}

/** Fully materialize the live page inside the transaction, before archive I/O. */
export function replaySnapshot(
  db: Db,
  input: JournalReplayRequest,
): ReplaySnapshot {
  const query = JournalReplayRequestSchema.parse(input);
  const high = highSequence(db);
  const through = query.through_seq ?? high;
  if (through > high || query.after_seq > through)
    throw new ContinuityError(
      "invalid-cursor",
      "Replay bounds must satisfy after_seq <= through_seq <= current sequence",
    );
  const pageThrough =
    query.after_seq + Math.min(query.limit, through - query.after_seq);
  const rows = db
    .select()
    .from(schema.journal)
    .where(
      and(
        gt(schema.journal.seq, query.after_seq),
        lte(schema.journal.seq, pageThrough),
      ),
    )
    .orderBy(schema.journal.seq)
    .all();
  return {
    after_seq: query.after_seq,
    through_seq: through,
    page_through_seq: pageThrough,
    archived_through_seq: getArchiveWatermark(db)?.lastArchivedSeq ?? 0,
    events: rows.map((row) => ({
      seq: row.seq,
      t: row.t,
      kind: row.kind,
      resource: row.resource,
      principal_id: row.principal_id,
      participant_id: row.participant_id,
      environment: JSON.parse(row.environment),
      token_id: row.token_id,
      fence: row.fence,
      data: JSON.parse(row.data),
    })),
  };
}

export function getHandoff(db: Db, id: string): Handoff | null {
  const row = db
    .select()
    .from(schema.handoffs)
    .where(eq(schema.handoffs.id, id))
    .get();
  return row ? HandoffSchema.parse(JSON.parse(row.snapshot)) : null;
}
export function createHandoff(
  db: Db,
  identity: IdentityContext,
  input: HandoffCreateRequest,
): Handoff {
  const request = HandoffCreateRequestSchema.parse(input);
  const requestJson = continuityJson(request);
  if (requestJson.length > 256 * 1024)
    throw new ContinuityError("validation-error", "Handoff exceeds 256 KiB");
  return db.transaction((tx) => {
    const existing = tx
      .select()
      .from(schema.handoffs)
      .where(eq(schema.handoffs.id, request.id))
      .get();
    if (existing) {
      if (
        existing.principal_id !== identity.principal_id ||
        existing.participant_id !== identity.participant_id ||
        existing.request_json !== requestJson
      ) {
        throw new ContinuityError(
          "handoff-conflict",
          "Handoff ID already exists with a different creator or content",
          409,
        );
      }
      return HandoffSchema.parse(JSON.parse(existing.snapshot));
    }
    if (request.based_on_seq > highSequence(tx))
      throw new ContinuityError(
        "invalid-cursor",
        "Handoff cannot be based on a future sequence",
      );
    if (request.supersedes_id && !getHandoff(tx, request.supersedes_id))
      throw new ContinuityError(
        "handoff-not-found",
        "Superseded handoff does not exist",
        404,
      );
    const now = Date.now();
    const activeClaims = listClaims(tx, now).filter(
      (claim) =>
        claim.principal_id === identity.principal_id &&
        claim.participant_id === identity.participant_id,
    );
    appendJournal(tx, {
      kind: "handoff.created",
      resource: `handoff:${request.id}`,
      actor: identity.principal_id,
      principalId: identity.principal_id,
      participantId: identity.participant_id,
      environment: identity.environment,
      data: { id: request.id, based_on_seq: request.based_on_seq },
    });
    const handoff: Handoff = {
      ...request,
      creator: identity,
      created_at: now,
      created_seq: highSequence(tx),
      active_claims: activeClaims,
    };
    tx.insert(schema.handoffs)
      .values({
        id: request.id,
        principal_id: identity.principal_id,
        participant_id: identity.participant_id,
        created_seq: handoff.created_seq,
        request_json: requestJson,
        snapshot: JSON.stringify(handoff),
      })
      .run();
    const resources = new Set(
      request.references.map((reference) => {
        switch (reference.type) {
          case "task":
            return `task:${reference.id}`;
          case "record":
            return `record:${reference.record_type}:${reference.key}`;
          case "artifact":
            return `artifact:${reference.key}`;
          case "claim":
            return reference.resource;
        }
      }),
    );
    for (const resource of resources)
      tx.insert(schema.handoffReferences)
        .values({ handoff_id: request.id, resource })
        .run();
    return handoff;
  });
}

export function listHandoffs(
  db: Db,
  identity: IdentityContext,
  input: HandoffListRequest = {},
): HandoffListResponse {
  const query = HandoffListRequestSchema.parse(input);
  const conditions = query.resource
    ? [
        inArray(
          schema.handoffs.id,
          db
            .select({ id: schema.handoffReferences.handoff_id })
            .from(schema.handoffReferences)
            .where(eq(schema.handoffReferences.resource, query.resource)),
        ),
      ]
    : [
        eq(schema.handoffs.principal_id, identity.principal_id),
        eq(schema.handoffs.participant_id, identity.participant_id),
      ];
  if (query.before_seq !== undefined)
    conditions.push(lt(schema.handoffs.created_seq, query.before_seq));
  const rows = db
    .select()
    .from(schema.handoffs)
    .where(and(...conditions))
    .orderBy(desc(schema.handoffs.created_seq))
    .limit(query.limit + 1)
    .all();
  const selected = rows.slice(0, query.limit);
  return {
    ok: true,
    handoffs: selected.map((row) =>
      HandoffSchema.parse(JSON.parse(row.snapshot)),
    ),
    next_before_seq:
      rows.length > query.limit
        ? selected[selected.length - 1].created_seq
        : null,
  };
}

function selectReentryHandoff(
  db: Db,
  identity: IdentityContext,
  resource: string | undefined,
): Handoff | null {
  let newest: Handoff | null = null;
  let before_seq: number | undefined;
  do {
    const page = listHandoffs(db, identity, {
      resource,
      before_seq,
      limit: 100,
    });
    newest ??= page.handoffs[0] ?? null;
    const work = page.handoffs.find((handoff) => handoff.kind !== "shutdown");
    if (work) return work;
    before_seq = page.next_before_seq ?? undefined;
  } while (before_seq !== undefined);
  return newest;
}

export function reentrySnapshot(
  db: Db,
  identity: IdentityContext,
  input: ReentryRequest = {},
): ReentrySnapshot {
  const query = ReentryRequestSchema.parse(input);
  return db.transaction((tx) => {
    const now = Date.now();
    const handoff = query.handoff_id
      ? getHandoff(tx, query.handoff_id)
      : selectReentryHandoff(tx, identity, query.resource);
    if (query.handoff_id && !handoff)
      throw new ContinuityError(
        "handoff-not-found",
        "Handoff does not exist",
        404,
      );
    const cursor = getCursor(tx, identity);
    const after =
      query.after_seq ??
      (cursor.updated_at !== null ? cursor.seq : (handoff?.based_on_seq ?? 0));
    return {
      summary: getSummary(tx, now),
      active_claims: listClaims(tx, now),
      pending_signals: inbox(tx, identity, now),
      handoff,
      replay: replaySnapshot(tx, {
        after_seq: after,
        through_seq: query.through_seq,
        limit: query.limit,
      }),
    };
  });
}
