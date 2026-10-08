import { timed } from "../measure";
import type {
  OpOutcome,
  Participant,
  Scenario,
  ScenarioContext,
} from "../types";

const TTL_MS = 30_000;
const RENEWS = 3;

const resourceFor = (ctx: ScenarioContext, p: Participant) =>
  `bench:${ctx.runId}:u${p.index}`;

const phases = new Map<string, number>();
const fences = new Map<string, number>();

/**
 * Each participant cycles acquire → renew×3 → release on its own resource.
 * Unpaced runs do the whole cycle per iteration. Paced runs (`--cadence`)
 * do ONE call per iteration so the cadence applies per operation, which is
 * what the "500 ms cadence" design target in docs/01-DECISIONS.md means.
 */
export const claimsUncontended: Scenario = {
  name: "claims-uncontended",
  description:
    "Per-participant resource: acquire (exclusive), renew x3, release. No contention; pure claim-path cost.",
  tiers: ["inproc", "embedded", "http"],
  async setup() {},
  async op(ctx, p) {
    const resource = resourceFor(ctx, p);
    if (ctx.cadenceMs) return pacedStep(ctx, p, resource);
    const out: OpOutcome[] = [];
    const acquire = await timed("acquire", () =>
      p.tila.claims.acquire(resource, "exclusive", TTL_MS),
    );
    out.push(acquire);
    if (acquire.cls !== "ok" || !acquire.value) return out;
    const fence = acquire.value.fence;
    for (let i = 0; i < RENEWS; i++) {
      out.push(
        await timed("renew", () =>
          p.tila.claims.renew(resource, fence, TTL_MS),
        ),
      );
    }
    out.push(
      await timed("release", () => p.tila.claims.release(resource, fence)),
    );
    return out;
  },
  async teardown(ctx) {
    for (const p of ctx.participants) {
      try {
        const list = await p.tila.claims.list();
        const own = list.claims.find(
          (c: { resource: string; participant_id: string }) =>
            c.resource === resourceFor(ctx, p) &&
            c.participant_id === p.participantId,
        );
        if (own) await p.tila.claims.release(own.resource, own.fence);
      } catch {
        // best effort
      }
    }
  },
  dataset(ctx) {
    return {
      resources: ctx.participants.length,
      ttl_ms: TTL_MS,
      renews_per_cycle: RENEWS,
    };
  },
  invariants(_ctx, rec) {
    return [
      { name: "no errors", ok: rec.total("error") === 0 },
      {
        name: "no conflicts on disjoint resources",
        ok: rec.total("conflict") === 0,
      },
      { name: "no stale fences", ok: rec.total("stale_fence") === 0 },
    ];
  },
};

/** One call of the acquire → renew×3 → release cycle, advancing a per-participant phase. */
async function pacedStep(
  ctx: ScenarioContext,
  p: Participant,
  resource: string,
): Promise<OpOutcome[]> {
  const key = `${ctx.runId}:${p.index}`;
  const phase = phases.get(key) ?? 0;
  const fence = fences.get(key) ?? 0;
  if (phase === 0) {
    const acquire = await timed("acquire", () =>
      p.tila.claims.acquire(resource, "exclusive", TTL_MS),
    );
    if (acquire.cls === "ok" && acquire.value) {
      fences.set(key, acquire.value.fence);
      phases.set(key, 1);
    }
    return [acquire];
  }
  if (phase <= RENEWS) {
    const renew = await timed("renew", () =>
      p.tila.claims.renew(resource, fence, TTL_MS),
    );
    phases.set(key, renew.cls === "ok" ? phase + 1 : 0);
    return [renew];
  }
  const release = await timed("release", () =>
    p.tila.claims.release(resource, fence),
  );
  phases.set(key, 0);
  return [release];
}
