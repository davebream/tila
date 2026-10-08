import { sleep, timed } from "../measure";
import type { OpOutcome, Scenario } from "../types";

const WARM_READS = 3;
const SETTLE_MS = 2_000;

/**
 * http tier only. Evict the project DO through the admin restart route, then
 * time the first request (cold) and a few follow-ups (warm). Never polls for
 * eviction; the explicit restart is the only trigger.
 */
export const coldStart: Scenario = {
  name: "cold-start",
  description:
    "POST /admin/restart to evict the DO, then time the first summary read (cold) and three more (warm after restart).",
  tiers: ["http"],
  requiresAdmin: true,
  explicitOnly: true,
  async setup(ctx) {
    ctx.extra.restarts = 0;
    ctx.extra.restart_failures = 0;
  },
  async op(ctx, p) {
    if (p.index !== 0 || !p.rawFetch) return [];
    const out: OpOutcome[] = [];
    // The Worker acknowledges the deliberate DO abort with 200 { ok: true }.
    // A server error is a failed trigger, not evidence that eviction occurred.
    const restart = await timed("restart", async () => {
      const res = await p.rawFetch?.(`/projects/${p.projectId}/admin/restart`, {
        method: "POST",
      });
      if (!res) throw new Error("restart: no response");
      if (
        res.status === 200 &&
        ((await res.json()) as { ok?: boolean }).ok === true
      )
        return res.status;
      throw Object.assign(new Error(`restart HTTP ${res.status}`), {
        status: res.status,
      });
    });
    out.push(restart);
    if (restart.cls !== "ok") {
      ctx.extra.restart_failures++;
      return out;
    }
    ctx.extra.restarts++;
    out.push(await timed("cold_first_request", () => p.tila.summary.get()));
    for (let i = 0; i < WARM_READS; i++)
      out.push(await timed("warm_after_restart", () => p.tila.summary.get()));
    await sleep(SETTLE_MS, ctx.signal);
    return out;
  },
  async teardown() {},
  dataset(ctx) {
    return {
      iterations: ctx.params.coldStartIterations,
      warm_reads: WARM_READS,
      settle_ms: SETTLE_MS,
    };
  },
  invariants(ctx, rec) {
    return [
      { name: "no errors", ok: rec.total("error") === 0 },
      {
        name: "DO answered after every restart",
        ok: rec.count("cold_first_request", "ok") === ctx.extra.restarts,
      },
    ];
  },
};
