import { sleep, timed, yieldMacrotask } from "../measure";
import type {
  OpOutcome,
  Participant,
  Scenario,
  ScenarioContext,
} from "../types";

const TTL_MS = 5_000;

interface HotState {
  lastFence: number;
  lastHolder: string | null;
  held: boolean;
}

const states = new Map<string, Map<string, HotState>>();
const startSeqs = new Map<string, number>();
const MAX_AUDIT_PAGES = 5000;

export function hotResource(ctx: ScenarioContext, p: Participant): string {
  return `bench:${ctx.runId}:hot${p.index % ctx.params.groups}`;
}

function stateFor(ctx: ScenarioContext, resource: string): HotState {
  let map = states.get(ctx.runId);
  if (!map) {
    map = new Map();
    states.set(ctx.runId, map);
  }
  let s = map.get(resource);
  if (!s) {
    s = { lastFence: 0, lastHolder: null, held: false };
    map.set(resource, s);
  }
  return s;
}

/**
 * N participants hammer G hot resources (G=1: everyone on one). In exclusive
 * mode losers get 409 already-held (conflict). In owner mode a different
 * participant under the same principal takes over and bumps the fence; the
 * displaced holder's release then fails (stale_fence). Cross-principal owner
 * attempts are conflicts.
 */
export const claimsContended: Scenario = {
  name: "claims-contended",
  description:
    "Participants contend for one or more hot resources: acquire, hold, release. Reports conflicts, takeovers and fence monotonicity.",
  tiers: ["inproc", "embedded", "http"],
  async setup(ctx) {
    ctx.extra.takeovers = 0;
    ctx.extra.fence_reorders_observed = 0;
    ctx.extra.journal_fence_regressions = 0;
    ctx.extra.journal_acquires_audited = 0;
    const entry = await ctx.participants[0].tila.reentry({ limit: 1 });
    startSeqs.set(ctx.runId, entry.changes.through_seq);
  },
  async op(ctx, p) {
    const resource = hotResource(ctx, p);
    const state = stateFor(ctx, resource);
    const out: OpOutcome[] = [];
    const acquire = await timed("acquire", () =>
      p.tila.claims.acquire(resource, ctx.params.mode, TTL_MS),
    );
    out.push(acquire);
    if (acquire.cls !== "ok" || !acquire.value) {
      if (acquire.cls === "conflict" && ctx.params.holdMs > 0)
        await sleep(Math.min(ctx.params.holdMs, 50), ctx.signal);
      return out;
    }
    const fence = acquire.value.fence;
    // Client-side observation only: over a network, responses arrive out of
    // server order, so this is informational. The invariant is audited from
    // the journal in teardown.
    if (fence < state.lastFence) ctx.extra.fence_reorders_observed++;
    // Owner mode: a successful acquire while another participant still holds
    // the claim is a same-principal takeover (fence bumped, holder displaced).
    if (
      ctx.params.mode === "owner" &&
      state.held &&
      state.lastHolder !== null &&
      state.lastHolder !== p.participantId
    )
      ctx.extra.takeovers++;
    state.lastFence = Math.max(state.lastFence, fence);
    state.lastHolder = p.participantId;
    state.held = true;
    // Hold across at least one macrotask so other participants actually
    // observe the claim; in-process tiers would otherwise never overlap.
    await yieldMacrotask();
    if (ctx.params.holdMs > 0) await sleep(ctx.params.holdMs, ctx.signal);
    if (state.lastHolder === p.participantId) state.held = false;
    out.push(
      await timed("release", () => p.tila.claims.release(resource, fence)),
    );
    return out;
  },
  async teardown(ctx) {
    for (const p of ctx.participants) {
      try {
        const list = await p.tila.claims.list();
        for (const c of list.claims)
          if (
            c.participant_id === p.participantId &&
            c.resource.startsWith(`bench:${ctx.runId}:hot`)
          )
            await p.tila.claims.release(c.resource, c.fence);
      } catch {
        // best effort
      }
    }
    await auditJournalFences(ctx);
  },
  dataset(ctx) {
    return {
      hot_resources: ctx.params.groups,
      mode: ctx.params.mode,
      hold_ms: ctx.params.holdMs,
      ttl_ms: TTL_MS,
      principals: new Set(ctx.participants.map((p) => p.principalId)).size,
    };
  },
  invariants(ctx, rec) {
    const inv = [
      { name: "no errors", ok: rec.total("error") === 0 },
      {
        name: "journal fences never regress per resource",
        ok: ctx.extra.journal_fence_regressions === 0,
        detail: `${ctx.extra.journal_fence_regressions} regressions in ${ctx.extra.journal_acquires_audited} acquires`,
      },
      {
        name: "outcome classes sum to ops",
        ok:
          rec.total("ok") +
            rec.total("conflict") +
            rec.total("stale_fence") +
            rec.total("error") ===
          rec.total(),
      },
    ];
    if (ctx.params.mode === "owner" && ctx.participants.length > 1)
      inv.push({
        name: "owner mode: same-principal takeovers observed",
        ok: ctx.extra.takeovers > 0,
        detail: `${ctx.extra.takeovers} takeovers`,
      });
    return inv;
  },
};

/**
 * Walk the journal in sequence order and check that `claim.acquired` fences
 * for each hot resource never decrease. This is the server's order, so it is
 * immune to the response reordering a client sees under concurrency.
 */
async function auditJournalFences(ctx: ScenarioContext): Promise<void> {
  const startSeq = startSeqs.get(ctx.runId);
  const auditor = ctx.participants[0];
  if (startSeq === undefined || !auditor) return;
  const prefix = `bench:${ctx.runId}:hot`;
  const lastFence = new Map<string, number>();
  let after = startSeq;
  for (let page = 0; page < MAX_AUDIT_PAGES; page++) {
    let batch: Awaited<ReturnType<typeof auditor.tila.journal.replay>>;
    try {
      batch = await auditor.tila.journal.replay({
        after_seq: after,
        limit: 200,
      });
    } catch (err) {
      ctx.log(
        `claims-contended: journal audit aborted: ${(err as Error).message}`,
      );
      return;
    }
    for (const ev of batch.events) {
      if (ev.kind !== "claim.acquired" || !ev.resource.startsWith(prefix))
        continue;
      if (typeof ev.fence !== "number") continue;
      ctx.extra.journal_acquires_audited++;
      const prev = lastFence.get(ev.resource) ?? 0;
      if (ev.fence < prev) ctx.extra.journal_fence_regressions++;
      lastFence.set(ev.resource, Math.max(prev, ev.fence));
    }
    if (!batch.has_more || batch.events.length === 0) return;
    after = batch.next_after_seq;
  }
}
