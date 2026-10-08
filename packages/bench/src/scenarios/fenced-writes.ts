import { sleep, timed } from "../measure";
import type {
  OpOutcome,
  Participant,
  Scenario,
  ScenarioContext,
} from "../types";

const TTL_MS = 30_000;
const RECORD_TYPE = "bench";

interface HolderState {
  resource: string;
  id: string;
  fence: number;
  n: number;
}
interface RecordState {
  key: string;
  fence: number;
  n: number;
}
interface State {
  holders: Map<number, HolderState>;
  records: Map<number, RecordState>;
  thief: number | null;
  stealCounter: number;
}

const states = new Map<string, State>();
const stateOf = (ctx: ScenarioContext): State => {
  let s = states.get(ctx.runId);
  if (!s) {
    s = {
      holders: new Map(),
      records: new Map(),
      thief: null,
      stealCounter: 0,
    };
    states.set(ctx.runId, s);
  }
  return s;
};

/**
 * Fenced writes under stale-holder retries.
 *
 * tasks: every holder owns one task and keeps a claim on `task:<id>` (owner
 * mode). A thief participant (last index, same principal as holder 0 when
 * tokens are shared) takes over a random holder's claim every `stealEvery`
 * of its iterations. The holder's next update is rejected with 409
 * stale-fence, it re-acquires (owner mode takes the claim back with a fresh
 * fence) and continues.
 *
 * records: participants are paired on one record each; both `set` with the
 * fence they last saw. The loser gets stale-fence, refreshes via `get`, and
 * retries on its next iteration.
 */
export const fencedWrites: Scenario = {
  name: "fenced-writes",
  description:
    "Fenced task updates (owner-mode claims) with a thief forcing stale-fence retries, or CAS record writes between paired participants.",
  tiers: ["inproc", "embedded", "http"],
  async setup(ctx) {
    const s = stateOf(ctx);
    ctx.extra.steals = 0;
    ctx.extra.reacquires = 0;
    if (ctx.params.target === "tasks") {
      const thiefEnabled =
        ctx.participants.length >= 2 && ctx.params.stealEvery > 0;
      s.thief = thiefEnabled ? ctx.participants.length - 1 : null;
      for (const p of ctx.participants) {
        if (p.index === s.thief) continue;
        const id = `bench-${ctx.runId}-t${p.index}`;
        await p.tila.tasks.create(id, "task", {
          title: `bench ${p.index}`,
          n: 0,
        });
        const resource = `task:${id}`;
        const claim = await p.tila.claims.acquire(resource, "owner", TTL_MS);
        s.holders.set(p.index, { resource, id, fence: claim.fence, n: 0 });
      }
    } else {
      for (const p of ctx.participants) {
        const pair = Math.floor(p.index / 2);
        const key = `${ctx.runId}/r${pair}`;
        let fence: number;
        if (p.index % 2 === 0 || ctx.participants.length === 1) {
          const created = await p.tila.records.create(RECORD_TYPE, {
            key,
            value: { n: 0, owner: p.participantId },
          });
          fence = created.fence;
        } else {
          const other = s.records.get(p.index - 1);
          fence = other
            ? other.fence
            : (await p.tila.records.get(RECORD_TYPE, key)).fence;
        }
        s.records.set(p.index, { key, fence, n: 0 });
      }
    }
  },
  async op(ctx, p) {
    const s = stateOf(ctx);
    if (ctx.params.target === "records") return recordOp(ctx, p, s);
    if (p.index === s.thief) return thiefOp(ctx, p, s);
    return holderOp(ctx, p, s);
  },
  async teardown(ctx) {
    const s = stateOf(ctx);
    for (const p of ctx.participants) {
      try {
        const list = await p.tila.claims.list();
        for (const c of list.claims)
          if (
            c.participant_id === p.participantId &&
            c.resource.startsWith(`task:bench-${ctx.runId}-`)
          )
            await p.tila.claims.release(c.resource, c.fence);
      } catch {
        // best effort
      }
    }
    for (const [index, h] of s.holders) {
      const p = ctx.participants[index];
      try {
        const claim = await p.tila.claims.acquire(h.resource, "owner", TTL_MS);
        await p.tila.tasks.archive(h.id, claim.fence);
        await p.tila.claims.release(h.resource, claim.fence);
      } catch {
        // best effort
      }
    }
    for (const [index, r] of s.records) {
      if (index % 2 !== 0) continue;
      const p = ctx.participants[index];
      try {
        const current = await p.tila.records.get(RECORD_TYPE, r.key);
        await p.tila.records.archive(RECORD_TYPE, r.key, {
          fence: current.fence,
        });
      } catch {
        // best effort
      }
    }
  },
  dataset(ctx) {
    const s = stateOf(ctx);
    return {
      target: ctx.params.target,
      tasks: s.holders.size,
      records: new Set([...s.records.values()].map((r) => r.key)).size,
      thief: s.thief !== null,
      steal_every: ctx.params.stealEvery,
      ttl_ms: TTL_MS,
    };
  },
  invariants(ctx, rec) {
    const s = stateOf(ctx);
    const inv = [{ name: "no errors", ok: rec.total("error") === 0 }];
    const contended =
      ctx.params.target === "records"
        ? ctx.participants.length >= 2
        : s.thief !== null;
    if (contended)
      inv.push({
        name: "stale fences were rejected",
        ok: rec.total("stale_fence") > 0,
      });
    return inv;
  },
};

async function holderOp(
  ctx: ScenarioContext,
  p: Participant,
  s: State,
): Promise<OpOutcome[]> {
  const h = s.holders.get(p.index);
  if (!h) return [];
  const out: OpOutcome[] = [];
  const next = h.n + 1;
  const update = await timed("update", () =>
    p.tila.tasks.update(h.id, { n: next }, h.fence),
  );
  out.push(update);
  if (update.cls === "ok") {
    h.n = next;
    return out;
  }
  if (update.cls === "stale_fence") {
    const re = await timed("reacquire", () =>
      p.tila.claims.acquire(h.resource, "owner", TTL_MS),
    );
    out.push(re);
    if (re.cls === "ok" && re.value) {
      h.fence = re.value.fence;
      ctx.extra.reacquires++;
    }
  }
  return out;
}

async function thiefOp(
  ctx: ScenarioContext,
  p: Participant,
  s: State,
): Promise<OpOutcome[]> {
  s.stealCounter++;
  if (s.stealCounter % ctx.params.stealEvery !== 0) {
    await sleep(5, ctx.signal);
    return [];
  }
  const holders = [...s.holders.values()];
  if (holders.length === 0) return [];
  const victim = holders[Math.floor(ctx.rng() * holders.length)];
  const steal = await timed("steal", () =>
    p.tila.claims.acquire(victim.resource, "owner", TTL_MS),
  );
  if (steal.cls === "ok") ctx.extra.steals++;
  await sleep(5, ctx.signal);
  return [steal];
}

async function recordOp(
  ctx: ScenarioContext,
  p: Participant,
  s: State,
): Promise<OpOutcome[]> {
  const r = s.records.get(p.index);
  if (!r) return [];
  const out: OpOutcome[] = [];
  const next = r.n + 1;
  const set = await timed("set", () =>
    p.tila.records.set(RECORD_TYPE, r.key, {
      value: { n: next, owner: p.participantId },
      fence: r.fence,
    }),
  );
  out.push(set);
  if (set.cls === "ok" && set.value) {
    r.n = next;
    r.fence = set.value.fence;
    return out;
  }
  if (set.cls === "stale_fence") {
    const refresh = await timed("refresh", () =>
      p.tila.records.get(RECORD_TYPE, r.key),
    );
    out.push(refresh);
    if (refresh.cls === "ok" && refresh.value) r.fence = refresh.value.fence;
  }
  return out;
}
