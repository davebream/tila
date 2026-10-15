import {
  EnvironmentMetadataSchema,
  type JournalReplayResponse,
  type JournalResponse,
  JournalResponseSchema,
  type ReentryResponse,
} from "@tila/schemas";

export type ReplayEvent = JournalResponse["events"][number];
export interface JournalArchiveReader {
  /** Yield raw JSON rows; implementations must paginate object listings. */
  read(afterSeq: number, throughSeq: number): AsyncIterable<unknown>;
}
/** Exact-match selectors for project reports; absent fields do not constrain. */
export interface ReplayFilter {
  event_name?: string;
  correlation_id?: string;
}
export interface ReplaySnapshot {
  after_seq: number;
  through_seq: number;
  page_through_seq: number;
  archived_through_seq: number;
  events: ReplayEvent[];
  /**
   * Present only for a filtered request. `(after_seq, page_through_seq]` is
   * then the examined scan range rather than one page, and `limit` caps the
   * matches returned from it.
   */
  filter?: ReplayFilter & { limit: number };
}
export type ReentrySnapshot = Omit<ReentryResponse, "ok" | "changes"> & {
  replay: ReplaySnapshot;
};

export class ContinuityError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = "ContinuityError";
  }
}

/** Stable equality for JSON objects, independent of transport property order. */
export function continuityJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(continuityJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${continuityJson(v)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Match the v23 migration without inventing historical authenticated identities. */
export function normalizeArchiveEvent(value: unknown): ReplayEvent {
  if (!value || typeof value !== "object")
    throw new Error("Invalid archive event");
  const row = value as Record<string, unknown>;
  const environment =
    row.environment ??
    EnvironmentMetadataSchema.parse({
      ...(row.source ? { client_name: row.source } : {}),
      ...(row.source_version ? { client_version: row.source_version } : {}),
    });
  return JournalResponseSchema.shape.events.element.parse({
    ...row,
    principal_id: row.principal_id ?? `legacy-principal:${row.actor ?? ""}`,
    participant_id: row.participant_id ?? `legacy-event:${row.seq}`,
    environment,
    token_id: row.token_id ?? null,
    fence: row.fence ?? null,
  });
}

/** Consume streams incrementally; bound line size even for malformed archives. */
export async function* journalJsonLines(
  stream: ReadableStream<Uint8Array>,
): AsyncIterable<unknown> {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let pending = "";
  const parse = (line: string) => {
    if (line.length > 4 * 1024 * 1024)
      throw new Error("Archive row exceeds 4 MiB");
    return JSON.parse(line);
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      pending += done
        ? decoder.decode()
        : decoder.decode(value, { stream: true });
      let end = pending.indexOf("\n");
      while (end !== -1) {
        const line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        if (line.trim()) yield parse(line);
        end = pending.indexOf("\n");
      }
      if (pending.length > 4 * 1024 * 1024)
        throw new Error("Archive row exceeds 4 MiB");
      if (done) break;
    }
    if (pending.trim()) yield parse(pending);
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

/**
 * A report matches when every selector given equals its field exactly. Only
 * `custom.reported` rows can match: another kind, or a row without the selected
 * field, never does, whatever else its data holds.
 */
export function matchesReplayFilter(
  event: ReplayEvent,
  filter: ReplayFilter,
): boolean {
  if (event.kind !== "custom.reported") return false;
  const data = event.data as Record<string, unknown> | null;
  if (data === null || typeof data !== "object") return false;
  return (
    (filter.event_name === undefined ||
      data.event_name === filter.event_name) &&
    (filter.correlation_id === undefined ||
      data.correlation_id === filter.correlation_id)
  );
}

/**
 * Merge live and archived rows for the snapshot's range and prove every
 * sequence is present exactly once. Callers filter only after this succeeds, so
 * lost history is a 503, never an empty page.
 */
export async function resolveReplayEvents(
  snapshot: ReplaySnapshot,
  archives?: JournalArchiveReader,
): Promise<ReplayEvent[]> {
  const events = new Map<number, ReplayEvent>();
  const add = (event: ReplayEvent) => {
    if (
      event.seq <= snapshot.after_seq ||
      event.seq > snapshot.page_through_seq
    )
      return;
    const previous = events.get(event.seq);
    if (previous && continuityJson(previous) !== continuityJson(event)) {
      throw new ContinuityError(
        "journal-history-conflict",
        `Conflicting journal sequence ${event.seq}`,
        409,
      );
    }
    events.set(event.seq, event);
  };
  for (const event of snapshot.events) add(event);
  if (
    snapshot.after_seq <
    Math.min(snapshot.archived_through_seq, snapshot.page_through_seq)
  ) {
    if (!archives)
      throw new ContinuityError(
        "journal-history-unavailable",
        "Journal archives are unavailable",
        503,
      );
    try {
      for await (const raw of archives.read(
        snapshot.after_seq,
        snapshot.page_through_seq,
      ))
        add(normalizeArchiveEvent(raw));
    } catch (error) {
      if (error instanceof ContinuityError) throw error;
      throw new ContinuityError(
        "journal-history-unavailable",
        "Unable to read complete journal archives",
        503,
      );
    }
  }
  // Journal appends allocate contiguous committed sequences. A missing sequence
  // means lost/unreadable history, never a successful empty page.
  for (
    let seq = snapshot.after_seq + 1;
    seq <= snapshot.page_through_seq;
    seq++
  ) {
    if (!events.has(seq))
      throw new ContinuityError(
        "journal-history-unavailable",
        `Journal sequence ${seq} is unavailable`,
        503,
      );
  }
  return [...events.values()].sort((a, b) => a.seq - b.seq);
}

export async function completeReplay(
  snapshot: ReplaySnapshot,
  archives?: JournalArchiveReader,
): Promise<JournalReplayResponse> {
  const events = await resolveReplayEvents(snapshot, archives);
  const { filter } = snapshot;
  if (!filter) {
    return {
      ok: true,
      events,
      next_after_seq: snapshot.page_through_seq,
      through_seq: snapshot.through_seq,
      has_more: snapshot.page_through_seq < snapshot.through_seq,
    };
  }
  const matches = events.filter((event) => matchesReplayFilter(event, filter));
  // Progress is what was actually examined, so a client resumes without
  // skipping or repeating: the whole range, unless matches overflowed the limit.
  const returned = matches.slice(0, filter.limit);
  const nextAfterSeq =
    matches.length > filter.limit
      ? returned[returned.length - 1].seq
      : snapshot.page_through_seq;
  return {
    ok: true,
    events: returned,
    next_after_seq: nextAfterSeq,
    through_seq: snapshot.through_seq,
    has_more: nextAfterSeq < snapshot.through_seq,
  };
}
