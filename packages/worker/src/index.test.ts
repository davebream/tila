/**
 * Tests for the Worker `scheduled()` entrypoint hardening (PR17).
 *
 * Before PR17, `scheduled()` ran `runSweep` in `ctx.waitUntil(...)` with no
 * top-level catch. A throw BEFORE the per-project loop (e.g. the D1 registry
 * read failing) silently aborted the entire nightly sweep with no record — the
 * waitUntil promise rejected and nothing observed it. PR17 wraps the run so a
 * pre-loop throw is caught and recorded (log + an Analytics datapoint).
 *
 * We mock ./lib/sweep so runSweep REJECTS, isolating the scheduled() handler's
 * catch/record behavior (the unit under test) from runSweep's internals. The
 * backend-* packages are mocked so index.ts loads without real Cloudflare
 * bindings (the cloudflare:workers import is not available under node vitest);
 * this mirrors run-worker-first-coverage.test.ts.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@tila/backend-d1", () => ({
  D1ProjectRegistry: vi.fn(),
  D1SessionStore: vi.fn(),
  D1RateLimitStore: vi.fn(),
  D1TokenStore: vi.fn(),
}));
vi.mock("@tila/backend-r2", () => ({ R2ArtifactBackend: vi.fn() }));
vi.mock("@tila/backend-do", () => ({ ProjectDO: vi.fn() }));
vi.mock("./lib/session-cache", () => ({
  getSessionFromCache: vi.fn().mockReturnValue(undefined),
  setSessionInCache: vi.fn(),
}));

// runSweep is forced to reject so we exercise scheduled()'s top-level catch.
// vi.hoisted lifts the spy above the hoisted vi.mock factory so the factory can
// reference it (the idiomatic Vitest pattern for a shared mock handle).
const { runSweep } = vi.hoisted(() => ({
  runSweep: vi.fn(async () => {
    throw new Error("D1 registry unreachable (pre-loop boom)");
  }),
}));
vi.mock("./lib/sweep", () => ({ runSweep }));

import worker from "./index";
import type { Env } from "./types";

function makeEnv(): { env: Env; writeDataPoint: ReturnType<typeof vi.fn> } {
  const writeDataPoint = vi.fn();
  const env = {
    DB: {} as unknown as D1Database,
    PROJECT: {} as unknown as DurableObjectNamespace,
    ARTIFACTS: {} as unknown as R2Bucket,
    ANALYTICS: { writeDataPoint } as unknown as AnalyticsEngineDataset,
  } as Env;
  return { env, writeDataPoint };
}

/** ExecutionContext stub that captures waitUntil promises so the test can
 *  observe whether the scheduled handler swallowed or leaked the rejection. */
function makeCtx(): { ctx: ExecutionContext; settled: Promise<unknown>[] } {
  const settled: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => {
      settled.push(p);
    },
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;
  return { ctx, settled };
}

describe("scheduled() — crash-safe sweep", () => {
  it("catches a pre-loop throw instead of letting the waitUntil promise reject", async () => {
    const { env } = makeEnv();
    const { ctx, settled } = makeCtx();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // scheduled() must not throw synchronously.
    expect(() =>
      worker.scheduled({} as ScheduledEvent, env, ctx),
    ).not.toThrow();

    // The work scheduled via waitUntil must RESOLVE (be caught), not reject —
    // a rejected waitUntil is the silent-abort bug PR17 fixes.
    expect(settled).toHaveLength(1);
    await expect(settled[0]).resolves.not.toThrow();

    errSpy.mockRestore();
  });

  it("records the pre-loop failure (log + Analytics datapoint)", async () => {
    const { env, writeDataPoint } = makeEnv();
    const { ctx, settled } = makeCtx();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    worker.scheduled({} as ScheduledEvent, env, ctx);
    await Promise.allSettled(settled);

    // The failure was logged.
    expect(errSpy).toHaveBeenCalled();
    // And recorded as an Analytics datapoint (forensic footprint for the cron).
    expect(writeDataPoint).toHaveBeenCalled();
    const call = writeDataPoint.mock.calls.at(-1)?.[0] as {
      blobs?: unknown[];
      indexes?: unknown[];
    };
    // The datapoint is tagged so it is queryable as a sweep-level error.
    expect(call.blobs).toContain("sweep_error");

    errSpy.mockRestore();
  });

  it("does not emit an error datapoint when the sweep succeeds", async () => {
    const { env, writeDataPoint } = makeEnv();
    const { ctx, settled } = makeCtx();
    runSweep.mockResolvedValueOnce({
      projectsSwept: 0,
      projectsDegraded: 0,
      artifactsExpired: 0,
      r2DeleteErrors: 0,
      driftChecksRun: 0,
      driftReconciled: 0,
      driftErrors: 0,
      expiredSessions: 0,
      journalEventsArchived: 0,
      projectStatuses: [],
      resumePoint: null,
    } as unknown as Awaited<ReturnType<typeof runSweep>>);

    worker.scheduled({} as ScheduledEvent, env, ctx);
    await Promise.allSettled(settled);

    // A clean run records no sweep_error datapoint (per-project emission, if
    // any, happens inside runSweep — which is mocked out here).
    const sweepErrorCalls = writeDataPoint.mock.calls.filter((c) =>
      (c[0] as { blobs?: unknown[] }).blobs?.includes("sweep_error"),
    );
    expect(sweepErrorCalls).toHaveLength(0);
  });
});
