import { timed } from "../measure";
import type {
  OpOutcome,
  Participant,
  Scenario,
  ScenarioContext,
} from "../types";

const TTL_MS = 30_000;
const PAGE = 200;

interface ReaderState {
  cursor: number;
  lagSum: number;
  lagSamples: number;
}
interface State {
  writers: number;
  readers: Map<number, ReaderState>;
}
const states = new Map<string, State>();
const stateOf = (ctx: ScenarioContext): State => {
  let s = states.get(ctx.runId);
  if (!s) {
    const n = ctx.participants.length;
    const writers = Math.min(
      n,
      ctx.params.writers ?? Math.max(1, Math.ceil(n / 2)),
    );
    s = { writers, readers: new Map() };
    states.set(ctx.runId, s);
  }
  return s;
};

/**
 * Writers acquire/release their own resource (two journal rows per cycle)
 * while readers tail the journal through the durable cursor: one `reentry`
 * to find a starting point, then `replay(after_seq)` + `acknowledge`.
 * Reader lag = snapshot through_seq − acknowledged seq.
 */
export const journalReplay: Scenario = {
  name: "journal-replay",
  description:
    "Writers append journal rows via claim cycles while readers page the journal with replay cursors and acknowledge progress.",
  tiers: ["inproc", "embedded", "http"],
  async setup(ctx) {
    const s = stateOf(ctx);
    ctx.extra.reader_lag_max = 0;
    ctx.extra.reader_lag_mean = 0;
    ctx.extra.seq_regressions = 0;
    ctx.extra.seq_gaps = 0;
    ctx.extra.pages_with_events = 0;
    for (const p of ctx.participants.slice(s.writers)) {
      const entry = await p.tila.reentry({ limit: 1 });
      s.readers.set(p.index, {
        cursor: entry.changes.through_seq,
        lagSum: 0,
        lagSamples: 0,
      });
    }
  },
  async op(ctx, p) {
    const s = stateOf(ctx);
    if (p.index < s.writers) return writerOp(ctx, p);
    return readerOp(ctx, p, s);
  },
  async teardown(ctx) {
    const s = stateOf(ctx);
    for (const p of ctx.participants.slice(0, s.writers)) {
      try {
        const list = await p.tila.claims.list();
        for (const c of list.claims)
          if (
            c.participant_id === p.participantId &&
            c.resource.startsWith(`bench:${ctx.runId}:j`)
          )
            await p.tila.claims.release(c.resource, c.fence);
      } catch {
        // best effort
      }
    }
    let sum = 0;
    let n = 0;
    for (const r of s.readers.values()) {
      sum += r.lagSum;
      n += r.lagSamples;
    }
    ctx.extra.reader_lag_mean = n === 0 ? 0 : Math.round((sum / n) * 100) / 100;
  },
  dataset(ctx) {
    const s = stateOf(ctx);
    return {
      writers: s.writers,
      readers: s.readers.size,
      page_limit: PAGE,
      ttl_ms: TTL_MS,
    };
  },
  invariants(ctx, rec) {
    return [
      { name: "no errors", ok: rec.total("error") === 0 },
      {
        name: "replay pages are strictly increasing",
        ok: ctx.extra.seq_regressions === 0,
      },
      {
        name: "no sequence gaps inside pages",
        ok: ctx.extra.seq_gaps === 0,
        detail: `${ctx.extra.seq_gaps} gaps`,
      },
    ];
  },
};

async function writerOp(
  ctx: ScenarioContext,
  p: Participant,
): Promise<OpOutcome[]> {
  const resource = `bench:${ctx.runId}:j${p.index}`;
  const out: OpOutcome[] = [];
  const acquire = await timed("write_acquire", () =>
    p.tila.claims.acquire(resource, "exclusive", TTL_MS),
  );
  out.push(acquire);
  if (acquire.cls === "ok" && acquire.value)
    out.push(
      await timed("write_release", () =>
        p.tila.claims.release(resource, acquire.value?.fence ?? 0),
      ),
    );
  return out;
}

async function readerOp(
  ctx: ScenarioContext,
  p: Participant,
  s: State,
): Promise<OpOutcome[]> {
  const r = s.readers.get(p.index);
  if (!r) return [];
  const out: OpOutcome[] = [];
  const replay = await timed("replay", () =>
    p.tila.journal.replay({ after_seq: r.cursor, limit: PAGE }),
  );
  out.push(replay);
  if (replay.cls !== "ok" || !replay.value) return out;
  const page = replay.value;
  let last = r.cursor;
  for (const ev of page.events) {
    if (ev.seq <= last) ctx.extra.seq_regressions++;
    else if (last !== r.cursor && ev.seq !== last + 1) ctx.extra.seq_gaps++;
    last = ev.seq;
  }
  if (page.events.length > 0) {
    ctx.extra.pages_with_events++;
    const ack = await timed("acknowledge", () =>
      p.tila.journal.acknowledge({ seq: last }),
    );
    out.push(ack);
    if (ack.cls === "ok") r.cursor = last;
  }
  const lag = Math.max(0, page.through_seq - r.cursor);
  r.lagSum += lag;
  r.lagSamples++;
  if (lag > ctx.extra.reader_lag_max) ctx.extra.reader_lag_max = lag;
  return out;
}
