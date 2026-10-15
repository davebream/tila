import {
  ContinuityError,
  type JournalArchiveReader,
  type ReplayEvent,
  matchesReplayFilter,
  resolveReplayEvents,
} from "@tila/core";
import {
  type Capability,
  type CredentialPolicy,
  JOURNAL_REPLAY_SCAN_BUDGET,
  type JournalReplayRequest,
  JournalReplayRequestSchema,
  type JournalReplayResponse,
  permitsRecordSide,
  permitsTask,
  recordResourceTarget,
} from "@tila/schemas";
import { and, asc, desc, gt, lte, max, min, sql } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { highSequence, replayWindow } from "./continuity-ops";
import {
  type JournalListEvent,
  type JournalListQuery,
  journalFilterConditions,
  journalRowToEvent,
} from "./journal-ops";
import * as schema from "./schema";

type Db = BaseSQLiteDatabase<"sync", unknown, typeof schema>;

/**
 * What a namespace-restricted credential may read from the journal.
 *
 * This is an allowlist of event kinds, and for each kind of the resource it
 * names and the payload it may carry. Every other kind, every resource that is
 * not exactly the shape its kind produces, and every payload that holds
 * anything the allowlist does not name is hidden, so a kind or reference added
 * later stays hidden until it is added here on purpose.
 *
 * One predicate serves live rows and archived rows alike: both reach
 * {@link visibleJournalEvents} as plain events.
 */
const ENTITY_KINDS: ReadonlySet<string> = new Set([
  "entity.created",
  "entity.updated",
  "entity.archived",
]);
const CLAIM_KINDS: ReadonlySet<string> = new Set([
  "claim.acquired",
  "claim.renewed",
  "claim.released",
  "claim.expired",
]);
const RECORD_KINDS: ReadonlySet<string> = new Set([
  "record.created",
  "record.updated",
  "record.archived",
  "record.unarchived",
]);

/** The kinds a restricted credential can ever see; a SQL pre-filter only. */
export const SCOPED_JOURNAL_KINDS: readonly string[] = [
  ...ENTITY_KINDS,
  ...CLAIM_KINDS,
  ...RECORD_KINDS,
];

/**
 * The payload keys an allowlisted kind may carry, with the type of each value.
 * Entity, record and claim acquire/renew/release events carry none. A payload
 * with any other key, or a value that is not the primitive named here, may be
 * holding a reference the predicate cannot judge, so the event is hidden.
 */
type PayloadType = "string" | "number";
const PAYLOAD_SHAPES: ReadonlyMap<
  string,
  Readonly<Record<string, PayloadType>>
> = new Map([
  [
    "claim.expired",
    {
      mode: "string",
      expired_at: "number",
      principal_id: "string",
      participant_id: "string",
    },
  ],
]);

/** A stored null is allowed: the emitter writes what the claim row held. */
function hasPayloadType(value: unknown, type: PayloadType): boolean {
  if (value === null) return true;
  return type === "string"
    ? typeof value === "string"
    : typeof value === "number";
}

function payloadAllowed(kind: string, data: unknown): boolean {
  if (data === null || typeof data !== "object" || Array.isArray(data))
    return false;
  const shape = PAYLOAD_SHAPES.get(kind) ?? {};
  return Object.entries(data).every(([key, value]) => {
    const expected = Object.hasOwn(shape, key) ? shape[key] : undefined;
    return expected !== undefined && hasPayloadType(value, expected);
  });
}

/** What an event must be readable as before the credential may see it. */
type Subject =
  | { class: "task"; id: string; type?: string }
  | { class: "record"; type: string; key: string; shadowTaskId?: string };

function subjectOf(
  event: { kind: string; resource: string; data: unknown },
  policy: CredentialPolicy,
): Subject | undefined {
  const has = (capability: Capability) =>
    policy.capabilities.includes(capability);
  const { kind, resource } = event;
  if (ENTITY_KINDS.has(kind)) {
    // The resource of an entity event is the bare task id.
    if (!has("tasks:read") || resource === "") return undefined;
    return payloadAllowed(kind, event.data)
      ? { class: "task", id: resource }
      : undefined;
  }
  if (CLAIM_KINDS.has(kind)) {
    if (!has("claims:read") || !payloadAllowed(kind, event.data))
      return undefined;
    if (resource.startsWith("record:")) {
      const target = recordResourceTarget(resource);
      // `record:<id>` is also what a claim on a task of type "record" is
      // named, so a task that would share the name makes it ambiguous.
      return target === undefined
        ? undefined
        : {
            class: "record",
            ...target,
            shadowTaskId: resource.slice("record:".length),
          };
    }
    // Claims on tasks are canonical `<type>:<id>`; any other resource string
    // (a custom lock name, a bare id) is not something to judge by its look.
    const colon = resource.indexOf(":");
    return colon < 1 || colon === resource.length - 1
      ? undefined
      : {
          class: "task",
          type: resource.slice(0, colon),
          id: resource.slice(colon + 1),
        };
  }
  if (RECORD_KINDS.has(kind)) {
    if (!has("records:read") || !payloadAllowed(kind, event.data))
      return undefined;
    const target = recordResourceTarget(resource);
    return target === undefined ? undefined : { class: "record", ...target };
  }
  return undefined;
}

// Durable Object SQLite refuses a statement that binds more than 100 values, so
// ids travel as one JSON parameter and the list itself is bounded.
const LOOKUP_CHUNK = 500;

interface TaskRow {
  type: string;
  parent_id: unknown;
}

function loadTasks(db: Db, ids: readonly string[]): Map<string, TaskRow> {
  const found = new Map<string, TaskRow>();
  for (let offset = 0; offset < ids.length; offset += LOOKUP_CHUNK) {
    const chunk = ids.slice(offset, offset + LOOKUP_CHUNK);
    const rows = db
      .select({
        id: schema.entities.id,
        type: schema.entities.type,
        parent_id: sql<unknown>`json_extract(${schema.entities.data}, '$.parent_id')`,
      })
      .from(schema.entities)
      .where(
        sql`${schema.entities.id} IN (SELECT value FROM json_each(${JSON.stringify(chunk)}))`,
      )
      .all();
    for (const row of rows)
      found.set(row.id, { type: row.type, parent_id: row.parent_id });
  }
  return found;
}

/**
 * The events of `events` the credential may read, in their given order.
 *
 * Tasks follow the rule `taskRestrictionCondition` applies to a task list: the
 * type is permitted and, when types are restricted, any parent exists and has a
 * permitted type. Records follow the READ side of the record namespace. A claim
 * is visible only when the resource it names is. Everything is judged against
 * current state, in one synchronous pass.
 */
export function visibleJournalEvents<
  T extends { kind: string; resource: string; data: unknown },
>(db: Db, policy: CredentialPolicy, events: readonly T[]): T[] {
  const restrictions = policy.restrictions;
  const subjects = events.map((event) => subjectOf(event, policy));

  const taskIds = new Set<string>();
  for (const subject of subjects) {
    if (subject?.class === "task") taskIds.add(subject.id);
    else if (subject?.shadowTaskId !== undefined)
      taskIds.add(subject.shadowTaskId);
  }
  const tasks = loadTasks(db, [...taskIds]);

  const types = restrictions?.task_types;
  const parentIds = new Set<string>();
  if (types !== undefined)
    for (const task of tasks.values())
      if (typeof task.parent_id === "string" && types.includes(task.type))
        parentIds.add(task.parent_id);
  const parents = loadTasks(db, [...parentIds]);

  const taskReadable = (task: TaskRow | undefined, type?: string): boolean => {
    if (task === undefined || !permitsTask(restrictions, task.type))
      return false;
    if (type !== undefined && task.type !== type) return false;
    if (types === undefined) return true;
    if (task.parent_id === null || task.parent_id === undefined) return true;
    if (typeof task.parent_id !== "string") return false;
    const parent = parents.get(task.parent_id);
    return parent !== undefined && types.includes(parent.type);
  };

  return events.filter((_, index) => {
    const subject = subjects[index];
    if (subject === undefined) return false;
    if (subject.class === "task")
      return taskReadable(tasks.get(subject.id), subject.type);
    if (
      subject.shadowTaskId !== undefined &&
      tasks.get(subject.shadowTaskId)?.type === "record"
    )
      return false;
    return permitsRecordSide(restrictions, "read", subject.type, subject.key);
  });
}

/**
 * Largest `limit` a restricted list accepts. A larger one is refused rather
 * than clamped: a clamped page would look short.
 */
export const SCOPED_LIST_MAX_LIMIT = 1000;

// ---------------------------------------------------------------------------
// Bounded scans
//
// A restricted reader may be handed a journal where almost nothing is readable,
// so the cost of a request must not depend on how much of it is hidden. Every
// scoped read examines at most SCOPED_SCAN_LIMIT sequences, in windows that
// grow from SCOPED_SCAN_FIRST_SPAN to SCOPED_SCAN_MAX_SPAN. The bound is in
// sequences, never in rows or events seen, so where a scan stops depends on the
// global sequence alone: it says nothing about how many hidden events a window
// held, only that the window was examined.
//
// When the bound ends a request before the page is full, the response says so
// (`has_more: true`) and hands back the cursor to continue from. A short page
// is "caught up" only when `has_more` is false.
// ---------------------------------------------------------------------------

/** Sequences the first window of a scoped scan examines. */
export const SCOPED_SCAN_FIRST_SPAN = JOURNAL_REPLAY_SCAN_BUDGET;
/** Largest single window; the span doubles up to here while a page is unfilled. */
export const SCOPED_SCAN_MAX_SPAN = 8 * JOURNAL_REPLAY_SCAN_BUDGET;
/** Sequences one scoped read examines before it hands back a cursor. */
export const SCOPED_SCAN_LIMIT = 20 * JOURNAL_REPLAY_SCAN_BUDGET;

/** Where a forward scan stands between windows. */
export interface ScanState<T> {
  /** Visible events collected so far, oldest first. */
  page: T[];
  /** Highest sequence examined; the next window starts after it. */
  cursor: number;
  span: number;
  /** Sequences examined so far in this request. */
  examined: number;
}
export type ScanStep<T> =
  | {
      done: true;
      page: T[];
      /** Pass as `after_seq` to continue; never behind what was returned. */
      next_after_seq: number;
      has_more: boolean;
    }
  | { done: false; state: ScanState<T> };

export function startScan<T>(afterSeq: number): ScanState<T> {
  return {
    page: [],
    cursor: afterSeq,
    span: SCOPED_SCAN_FIRST_SPAN,
    examined: 0,
  };
}

/**
 * The last sequence of the next window: never past `through`, and never
 * further than the sequences this request may still examine.
 */
export function nextWindowEnd<T>(state: ScanState<T>, through: number): number {
  return (
    state.cursor +
    Math.max(
      1,
      Math.min(
        state.span,
        through - state.cursor,
        SCOPED_SCAN_LIMIT - state.examined,
      ),
    )
  );
}

/**
 * Fold the visible events of the window `(state.cursor, end]` into the page.
 * Pure: decides whether the page is complete, the range is exhausted or the
 * scan bound ends the request, and what cursor each of those hands back.
 *
 * - A visible event beyond a full page means more remains: the cursor stays
 *   right after the last returned event, so the next page starts at it.
 * - Reaching `through` means caught up, whatever was hidden on the way.
 * - Reaching the scan bound first means "more may remain": the cursor is the
 *   last sequence examined, and no readable event lies between it and the page.
 */
export function foldWindow<T extends { seq: number }>(
  state: ScanState<T>,
  end: number,
  visible: readonly T[],
  limit: number,
  through: number,
): ScanStep<T> {
  const page = [...state.page];
  for (const event of visible) {
    if (page.length >= limit)
      return {
        done: true,
        page,
        next_after_seq: page[page.length - 1].seq,
        has_more: true,
      };
    page.push(event);
  }
  const examined = state.examined + (end - state.cursor);
  if (end >= through)
    return { done: true, page, next_after_seq: through, has_more: false };
  if (examined >= SCOPED_SCAN_LIMIT)
    return { done: true, page, next_after_seq: end, has_more: true };
  return {
    done: false,
    state: {
      page,
      cursor: end,
      span: Math.min(state.span * 2, SCOPED_SCAN_MAX_SPAN),
      examined,
    },
  };
}

export interface ScopedList {
  events: JournalListEvent[];
  /**
   * Forward reads: a readable event is known to follow, or the scan bound
   * ended the request first. Tail reads: the bound ended the request before
   * `limit` events were found, so older readable events may exist.
   */
  has_more: boolean;
  /** Forward reads only: pass as `after_seq` to continue. */
  next_after_seq?: number;
}

/**
 * `listJournal` for a namespace-restricted credential: the same filters and the
 * same ordering, with hidden events skipped rather than counted, in at most
 * {@link SCOPED_SCAN_LIMIT} sequences. A short page means "caught up" only when
 * `has_more` is false.
 */
export function listScopedJournal(
  db: Db,
  policy: CredentialPolicy,
  query: JournalListQuery,
  watermark?: { lastArchivedSeq: number },
): ScopedList {
  // A cursor inside the archived region is answered by the caller's archive
  // indicator, exactly as for an unrestricted list.
  if (
    watermark !== undefined &&
    query.after_seq !== undefined &&
    query.after_seq < watermark.lastArchivedSeq
  )
    // Readable events may sit in the archive; `archived` tells the caller
    // where to read them, and the cursor must not move past them.
    return { events: [], has_more: true, next_after_seq: query.after_seq };
  const requested =
    query.kind === undefined
      ? undefined
      : Array.isArray(query.kind)
        ? query.kind
        : [query.kind];
  const kinds = SCOPED_JOURNAL_KINDS.filter(
    (kind) => requested === undefined || requested.includes(kind),
  );
  const limit = query.limit ?? 100;
  const live = db
    .select({ low: min(schema.journal.seq), high: max(schema.journal.seq) })
    .from(schema.journal)
    .get();
  const ascending = query.after_seq !== undefined;
  if (live?.low == null || live.high == null || kinds.length === 0)
    return ascending
      ? { events: [], has_more: false, next_after_seq: query.after_seq }
      : { events: [], has_more: false };
  // Live rows run from `low` to `high`: nothing below `low` is ever examined.
  const { low, high } = { low: live.low, high: live.high };

  const readWindow = (after: number, end: number, newestFirst: boolean) => {
    const rows = db
      .select()
      .from(schema.journal)
      .where(
        and(
          ...journalFilterConditions({
            ...query,
            kind: kinds,
            after_seq: undefined,
          }),
          gt(schema.journal.seq, after),
          lte(schema.journal.seq, end),
        ),
      )
      .orderBy(newestFirst ? desc(schema.journal.seq) : asc(schema.journal.seq))
      .all();
    return visibleJournalEvents(db, policy, rows.map(journalRowToEvent));
  };

  if (query.after_seq !== undefined) {
    const after = query.after_seq;
    if (after >= high)
      return { events: [], has_more: false, next_after_seq: after };
    let state = startScan<JournalListEvent>(Math.max(after, low - 1));
    for (;;) {
      const end = nextWindowEnd(state, high);
      const step = foldWindow(
        state,
        end,
        readWindow(state.cursor, end, false),
        limit,
        high,
      );
      if (step.done)
        return {
          events: step.page,
          has_more: step.has_more,
          next_after_seq: step.next_after_seq,
        };
      state = step.state;
    }
  }

  // The newest `limit` readable events, newest first, walking down from `high`.
  const events: JournalListEvent[] = [];
  let top = high;
  let span = SCOPED_SCAN_FIRST_SPAN;
  let examined = 0;
  while (top >= low) {
    const bottom = Math.max(
      low - 1,
      top - Math.min(span, SCOPED_SCAN_LIMIT - examined),
    );
    for (const event of readWindow(bottom, top, true)) {
      events.push(event);
      if (events.length >= limit) return { events, has_more: false };
    }
    examined += top - bottom;
    top = bottom;
    span = Math.min(span * 2, SCOPED_SCAN_MAX_SPAN);
    if (top >= low && examined >= SCOPED_SCAN_LIMIT)
      return { events, has_more: true };
  }
  return { events, has_more: false };
}

/**
 * `GET /journal/replay` for a namespace-restricted credential, complete on its
 * own: live rows come from `db`, archived rows from `archives`, and a window is
 * proven complete before any of it is filtered.
 *
 * The page holds up to `limit` visible events, found in at most
 * {@link SCOPED_SCAN_LIMIT} sequences. `has_more` is true only when a further
 * visible event is known to exist or the scan bound ended the request early;
 * hidden events move the cursor but are never counted, and `through_seq` is
 * the project's global sequence, as it is for every reader.
 */
export async function scopedReplay(
  db: Db,
  policy: CredentialPolicy,
  input: JournalReplayRequest,
  archives?: JournalArchiveReader,
): Promise<JournalReplayResponse> {
  const query = JournalReplayRequestSchema.parse(input);
  const high = highSequence(db);
  const through = query.through_seq ?? high;
  if (through > high || query.after_seq > through)
    throw new ContinuityError(
      "invalid-cursor",
      "Replay bounds must satisfy after_seq <= through_seq <= current sequence",
    );
  const filter = {
    event_name: query.event_name,
    correlation_id: query.correlation_id,
  };
  const filtered =
    filter.event_name !== undefined || filter.correlation_id !== undefined;
  const respond = (
    page: ReplayEvent[],
    next_after_seq: number,
    has_more: boolean,
  ): JournalReplayResponse => ({
    ok: true,
    events: page,
    next_after_seq,
    through_seq: through,
    has_more,
  });

  let state = startScan<ReplayEvent>(query.after_seq);
  while (state.cursor < through) {
    const { cursor } = state;
    const end = nextWindowEnd(state, through);
    const snapshot = db.transaction((tx) =>
      replayWindow(tx, cursor, end, through),
    );
    const events = await resolveReplayEvents(snapshot, archives);
    const visible = visibleJournalEvents(db, policy, events).filter(
      (event) => !filtered || matchesReplayFilter(event, filter),
    );
    const step = foldWindow(state, end, visible, query.limit, through);
    if (step.done)
      return respond(step.page, step.next_after_seq, step.has_more);
    state = step.state;
  }
  return respond([], through, false);
}
