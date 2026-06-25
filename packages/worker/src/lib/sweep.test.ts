/**
 * Unit tests for runSweep — the daily cron artifact/claim/presence cleanup
 * orchestration, extracted from the Worker entrypoint into lib/sweep.ts so it
 * can be unit-tested in isolation (this test is impossible while runSweep is
 * private/inline in index.ts).
 *
 * This test encodes the extraction seam: runSweep is importable and invokable
 * against stub env bindings, and returns a structured SweepSummary. It uses an
 * empty project registry so the per-project loop never runs — no DO or R2
 * traffic is exercised here. Behavior-level hardening of the loop is covered by
 * separate work (sweep-key.test.ts and later tasks); this only pins the seam.
 */
import { describe, expect, it, vi } from "vitest";
import { REVOCATION_GC_RETENTION_MS } from "../config";
import type { Env } from "../types";
import { type SweepSummary, runSweep } from "./sweep";

// Spies so the revocation-GC tests can drive deleteExpired behavior and assert
// the cutoff. The factory references hoisted vi.fn() instances; default impls
// return 0 so the seam tests (empty registry) still see zeroed counts.
const jtiDeleteExpired = vi.fn(async (_cutoff: number) => 0);
const subjectsDeleteExpired = vi.fn(async (_cutoff: number) => 0);

vi.mock("@tila/backend-d1", async (importActual) => {
  const actual = await importActual<typeof import("@tila/backend-d1")>();
  return {
    ...actual,
    D1RevokedJtiStore: class {
      deleteExpired = jtiDeleteExpired;
    },
    D1RevokedSubjectsStore: class {
      deleteExpired = subjectsDeleteExpired;
    },
  };
});

/**
 * Minimal D1 stub matching the drizzle-orm/d1 driver contract: prepare(sql)
 * returns a statement whose bind(...params) yields run/all/raw/first. listAll()
 * and deleteExpired() both resolve through bind().raw() (array-mode), so empty
 * arrays make both queries return zero rows without touching a real database.
 */
function makeEmptyD1(): D1Database {
  const boundStatement = {
    run: async () => ({ success: true, results: [], meta: {} }),
    all: async () => ({ success: true, results: [], meta: {} }),
    raw: async () => [],
    first: async () => null,
  };
  const stub = {
    prepare: vi.fn(() => ({
      bind: vi.fn(() => boundStatement),
      ...boundStatement,
    })),
    batch: vi.fn(async () => []),
    dump: vi.fn(),
    exec: vi.fn(async () => ({ count: 0, duration: 0 })),
  };
  return stub as unknown as D1Database;
}

/**
 * Builds a stub Env. With an empty project registry, PROJECT/ARTIFACTS are
 * never invoked, so they are throwing stubs that fail loudly if the seam ever
 * starts touching them with zero projects (a regression signal).
 */
function makeStubEnv(): Env {
  const failingProject = {
    idFromName: () => {
      throw new Error(
        "PROJECT.idFromName must not be called with zero projects",
      );
    },
    get: () => {
      throw new Error("PROJECT.get must not be called with zero projects");
    },
  } as unknown as DurableObjectNamespace;

  const failingArtifacts = {
    put: async () => {
      throw new Error("ARTIFACTS.put must not be called with zero projects");
    },
    delete: async () => {
      throw new Error("ARTIFACTS.delete must not be called with zero projects");
    },
  } as unknown as R2Bucket;

  return {
    DB: makeEmptyD1(),
    PROJECT: failingProject,
    ARTIFACTS: failingArtifacts,
    ANALYTICS: undefined as unknown as AnalyticsEngineDataset,
  } as Env;
}

describe("runSweep — extraction seam", () => {
  it("is importable and returns a structured SweepSummary", async () => {
    const env = makeStubEnv();

    const summary: SweepSummary = await runSweep(env);

    // Structured summary with all expected counters, zeroed for an empty registry.
    expect(summary).toEqual({
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
      revokedJtiPruned: 0,
      revokedSubjectsPruned: 0,
    });
  });

  it("sweeps no projects when the registry is empty", async () => {
    const env = makeStubEnv();

    const summary = await runSweep(env);

    expect(summary.projectsSwept).toBe(0);
  });
});

describe("runSweep — revocation GC", () => {
  it("prunes both revocation tables at cutoff now() - REVOCATION_GC_RETENTION_MS", async () => {
    jtiDeleteExpired.mockClear().mockResolvedValue(0);
    subjectsDeleteExpired.mockClear().mockResolvedValue(0);
    const env = makeStubEnv();
    const fixedNow = 2_000_000_000_000;

    await runSweep(env, { now: () => fixedNow });

    const expectedCutoff = fixedNow - REVOCATION_GC_RETENTION_MS;
    expect(jtiDeleteExpired).toHaveBeenCalledWith(expectedCutoff);
    expect(subjectsDeleteExpired).toHaveBeenCalledWith(expectedCutoff);
  });

  it("records the pruned counts in the summary", async () => {
    jtiDeleteExpired.mockClear().mockResolvedValue(3);
    subjectsDeleteExpired.mockClear().mockResolvedValue(5);
    const env = makeStubEnv();

    const summary = await runSweep(env, { now: () => 2_000_000_000_000 });

    expect(summary.revokedJtiPruned).toBe(3);
    expect(summary.revokedSubjectsPruned).toBe(5);
  });

  it("swallows a thrown jti prune and still runs the subject prune + rest of sweep", async () => {
    jtiDeleteExpired.mockClear().mockRejectedValue(new Error("jti prune boom"));
    subjectsDeleteExpired.mockClear().mockResolvedValue(7);
    const env = makeStubEnv();

    const summary = await runSweep(env, { now: () => 2_000_000_000_000 });

    // jti prune failed → its summary field stays undefined (non-fatal)
    expect(summary.revokedJtiPruned).toBeUndefined();
    // subject prune still ran in its own try/catch
    expect(subjectsDeleteExpired).toHaveBeenCalledTimes(1);
    expect(summary.revokedSubjectsPruned).toBe(7);
    // the rest of the sweep still completed
    expect(summary.resumePoint).toBeNull();
    expect(summary.projectsSwept).toBe(0);
  });

  it("swallows a thrown subject prune independently of the jti prune", async () => {
    jtiDeleteExpired.mockClear().mockResolvedValue(2);
    subjectsDeleteExpired
      .mockClear()
      .mockRejectedValue(new Error("subject prune boom"));
    const env = makeStubEnv();

    const summary = await runSweep(env, { now: () => 2_000_000_000_000 });

    expect(summary.revokedJtiPruned).toBe(2);
    expect(summary.revokedSubjectsPruned).toBeUndefined();
  });
});
