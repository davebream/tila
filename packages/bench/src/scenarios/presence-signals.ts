import { timed } from "../measure";
import type {
  OpOutcome,
  Participant,
  Scenario,
  ScenarioContext,
} from "../types";

const SIGNAL_TTL_MS = 60_000;

/** heartbeat → participant-targeted signal to a random peer → inbox → ack. */
export const presenceSignals: Scenario = {
  name: "presence-signals",
  description:
    "Presence heartbeat, then a participant-targeted signal to a random peer, then inbox read and acknowledgement of every pending bench signal.",
  tiers: ["inproc", "embedded", "http"],
  async setup(ctx) {
    ctx.extra.inbox_backlog_max = 0;
    ctx.extra.signals_sent = 0;
    ctx.extra.signals_acked = 0;
  },
  async op(ctx, p) {
    const out: OpOutcome[] = [];
    out.push(
      await timed("heartbeat", () =>
        p.tila.presence.heartbeat({ role: "bench" }),
      ),
    );
    const peer = pickPeer(ctx, p);
    if (peer) {
      const send = await timed("send", () =>
        p.tila.signals.send({
          target: {
            type: "participant",
            principal_id: peer.principalId,
            participant_id: peer.participantId,
          },
          kind: "info",
          payload: { run: ctx.runId, from: p.index },
          ttl_ms: SIGNAL_TTL_MS,
        }),
      );
      out.push(send);
      if (send.cls === "ok") ctx.extra.signals_sent++;
    }
    const inbox = await timed("inbox", () => p.tila.signals.inbox());
    out.push(inbox);
    if (inbox.cls === "ok" && inbox.value) {
      const pending = inbox.value.signals.filter(
        (sig) => (sig.payload as { run?: string } | null)?.run === ctx.runId,
      );
      if (pending.length > ctx.extra.inbox_backlog_max)
        ctx.extra.inbox_backlog_max = pending.length;
      for (const sig of pending) {
        const ack = await timed("ack", () => p.tila.signals.ack(sig.id));
        out.push(ack);
        if (ack.cls === "ok") ctx.extra.signals_acked++;
      }
    }
    return out;
  },
  async teardown(ctx) {
    for (const p of ctx.participants) {
      try {
        const inbox = await p.tila.signals.inbox();
        for (const sig of inbox.signals)
          if ((sig.payload as { run?: string } | null)?.run === ctx.runId) {
            await p.tila.signals.ack(sig.id);
            ctx.extra.signals_acked++;
          }
      } catch {
        // best effort
      }
    }
  },
  dataset(ctx) {
    return {
      participants: ctx.participants.length,
      signal_ttl_ms: SIGNAL_TTL_MS,
    };
  },
  invariants(ctx, rec) {
    return [
      { name: "no errors", ok: rec.total("error") === 0 },
      {
        name: "every sent signal was acknowledged after drain",
        ok: ctx.extra.signals_acked >= ctx.extra.signals_sent,
        detail: `${ctx.extra.signals_acked}/${ctx.extra.signals_sent}`,
      },
    ];
  },
};

function pickPeer(ctx: ScenarioContext, p: Participant): Participant | null {
  const n = ctx.participants.length;
  if (n < 2) return null;
  let idx = Math.floor(ctx.rng() * (n - 1));
  if (idx >= p.index) idx++;
  return ctx.participants[idx];
}
