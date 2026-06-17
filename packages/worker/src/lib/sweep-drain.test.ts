/**
 * Behavior tests for runSweep hardening (Task 8 / PR16).
 *
 * Unlike sweep.test.ts (which pins the extraction *seam* with an empty registry
 * and deliberately-throwing PROJECT/ARTIFACTS stubs), these tests drive a
 * POPULATED registry with WORKING DO/R2 stubs that return expired keys, journal
 * events, and drift findings. They verify the four hardening guarantees:
 *
 *   (a) drain   — a project with > batchSize expired artifacts is fully drained
 *                 across multiple /sweep calls within one run.
 *   (b) archive — archiving the same calendar month across two runs writes
 *                 DISTINCT R2 keys and never overwrites prior content.
 *   (c) status  — a failed archive/drift step marks the project `degraded`
 *                 (not fully swept), and the throw is isolated: sibling projects
 *                 still complete.
 *   (d) budget  — when the wall-clock budget is hit, the loop stops cleanly and
 *                 records a resume point (which project / phase).
 *
 * runSweep accepts an optional second argument so tests can inject the project
 * list, a deterministic clock, the time budget, and the batch size without
 * standing up real Cloudflare bindings. The production caller (index.ts) calls
 * runSweep(env) with no options and builds the registry from env.DB.
 */
import { describe, expect, it, vi } from "vitest";
import type { Env } from "../types";
import { runSweep } from "./sweep";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Empty D1 stub — session cleanup resolves through bind().raw() => []. */
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

interface JournalEvent {
  seq: number;
  t: number;
  kind: string;
  resource: string;
  actor: string;
  token_id: string | null;
  fence: number | null;
  data: Record<string, unknown>;
  source: string | null;
  source_version: string | null;
}

interface ProjectScript {
  /** Expired R2 keys still live (drains as /artifact/tombstone calls arrive). */
  expiredKeys: string[];
  /** Journal events returned by /journal/archive (consumed on confirm). */
  journalEvents?: JournalEvent[];
  /** Drift findings returned by /artifact/search-drift. */
  driftFindings?: Array<{ check: string; count: number; status: string }>;
  /**
   * Fault injection:
   *   sweep/archive/drift/tombstone — that DO endpoint throws (isolation tests)
   *   archive-r2                    — the R2 journal put throws
   *   tombstone-noop                — tombstone returns ok but does NOT remove
   *     the key, so /sweep keeps returning a full page → drain clamp trips
   */
  failOn?:
    | "sweep"
    | "archive"
    | "archive-r2"
    | "drift"
    | "tombstone"
    | "tombstone-noop";
}

/**
 * A fake DurableObjectNamespace whose `.get(id).fetch(url)` routes by path and
 * is backed by per-project mutable state. Tombstoning a key removes it from the
 * project's live expired set, exactly as listExpiredPointers(tombstoned=0)
 * behaves against real DO SQLite — this is what lets the drain loop terminate.
 */
function makeWorld(scripts: Record<string, ProjectScript>) {
  // Per-project R2 puts, keyed by projectId → r2Key → body.
  const r2Puts = new Map<string, Map<string, string>>();
  // Per-project list of every R2 put key in order (to catch overwrites).
  const r2PutOrder = new Map<string, string[]>();
  const archiveConfirms = new Map<string, number[]>(); // projectId → throughSeqs

  // Real-subrequest meter: every DO fetch and every R2 op counts as one
  // subrequest, mirroring the Cloudflare per-invocation cap. Tests assert this
  // never crosses 1000 for a large backlog.
  const meter = { subrequests: 0 };

  function r2Put(key: string, body: string) {
    // key format: journal-archive/<projectId>/<...>
    const parts = key.split("/");
    const projectId = parts[1] ?? "_";
    if (!r2Puts.has(projectId)) {
      r2Puts.set(projectId, new Map());
      r2PutOrder.set(projectId, []);
    }
    // biome-ignore lint/style/noNonNullAssertion: just initialized above
    r2Puts.get(projectId)!.set(key, body);
    // biome-ignore lint/style/noNonNullAssertion: just initialized above
    r2PutOrder.get(projectId)!.push(key);
  }

  const ARTIFACTS = {
    put: vi.fn(async (key: string, body: string) => {
      meter.subrequests++;
      // A project flagged `archive-r2` fails its R2 journal write, exercising
      // the "must not confirm/delete on a failed put" branch.
      const projectId = key.split("/")[1] ?? "_";
      if (scripts[projectId]?.failOn === "archive-r2") {
        throw new Error("R2 put boom");
      }
      r2Put(key, body);
    }),
    delete: vi.fn(async () => {
      meter.subrequests++;
      // R2 blob delete — no-op for the drain accounting.
    }),
  } as unknown as R2Bucket;

  function makeStub(projectId: string) {
    const script = scripts[projectId];
    return {
      fetch: vi.fn(async (req: Request | string, _init?: RequestInit) => {
        meter.subrequests++;
        const url = typeof req === "string" ? req : req.url;
        const path = new URL(url).pathname;

        if (path === "/sweep") {
          if (script.failOn === "sweep") throw new Error("DO /sweep boom");
          // batch_size is honored: return up to batchSize live keys.
          const body = JSON.parse(
            (typeof req === "string" ? _init?.body : null) as string,
          ) as { batch_size?: number };
          const batchSize = body.batch_size ?? 100;
          const keys = script.expiredKeys.slice(0, batchSize);
          return Response.json({ ok: true, expiredKeys: keys });
        }

        if (path === "/artifact/tombstone") {
          if (script.failOn === "tombstone") throw new Error("tombstone boom");
          const body = JSON.parse(_init?.body as string) as { r2_key: string };
          // Normally tombstoning removes the key from the live expired set, so
          // the next /sweep returns fewer keys and the drain terminates. The
          // `tombstone-noop` fault skips removal, so the candidate set never
          // shrinks → the drain hits its iteration clamp.
          if (script.failOn !== "tombstone-noop") {
            script.expiredKeys = script.expiredKeys.filter(
              (k) => k !== body.r2_key,
            );
          }
          return Response.json({ ok: true });
        }

        if (path === "/artifact/confirm-blob-deleted") {
          return Response.json({ ok: true });
        }

        if (path === "/journal/archive") {
          if (script.failOn === "archive") throw new Error("archive boom");
          const events = script.journalEvents ?? [];
          const throughSeq =
            events.length > 0 ? Math.max(...events.map((e) => e.seq)) : 0;
          return Response.json({
            ok: true,
            events,
            throughSeq,
            count: events.length,
          });
        }

        if (path === "/journal/archive/confirm") {
          const body = JSON.parse(_init?.body as string) as {
            throughSeq: number;
          };
          if (!archiveConfirms.has(projectId))
            archiveConfirms.set(projectId, []);
          // biome-ignore lint/style/noNonNullAssertion: just initialized
          archiveConfirms.get(projectId)!.push(body.throughSeq);
          // Simulate watermark advance: events <= throughSeq are gone.
          script.journalEvents = (script.journalEvents ?? []).filter(
            (e) => e.seq > body.throughSeq,
          );
          return Response.json({ ok: true, watermark: body.throughSeq });
        }

        if (path === "/artifact/search-drift") {
          if (script.failOn === "drift") throw new Error("drift boom");
          return Response.json({
            ok: true,
            findings: script.driftFindings ?? [],
          });
        }

        if (path === "/artifact/search-rebuild-scan") {
          return Response.json({ ok: true, pointers: [] });
        }
        if (path === "/artifact/search-rebuild") {
          return Response.json({ ok: true });
        }

        throw new Error(`unexpected DO path: ${path}`);
      }),
    };
  }

  const stubCache = new Map<string, ReturnType<typeof makeStub>>();
  const PROJECT = {
    idFromName: (name: string) => name as unknown as DurableObjectId,
    get: (id: DurableObjectId) => {
      const projectId = id as unknown as string;
      if (!stubCache.has(projectId))
        stubCache.set(projectId, makeStub(projectId));
      // biome-ignore lint/style/noNonNullAssertion: just initialized
      return stubCache.get(projectId)! as unknown as DurableObjectStub;
    },
  } as unknown as DurableObjectNamespace;

  const env = {
    DB: makeEmptyD1(),
    PROJECT,
    ARTIFACTS,
    ANALYTICS: undefined as unknown as AnalyticsEngineDataset,
  } as Env;

  /** Replace a project's pending journal events between runs (simulates new
   * events accruing after a prior archive cycle). */
  function reseedJournal(projectId: string, events: JournalEvent[]) {
    scripts[projectId].journalEvents = events;
  }

  return {
    env,
    r2Puts,
    r2PutOrder,
    archiveConfirms,
    ARTIFACTS,
    reseedJournal,
    meter,
  };
}

function evt(seq: number, t: number): JournalEvent {
  return {
    seq,
    t,
    kind: "task.created",
    resource: `task:${seq}`,
    actor: "tester",
    token_id: null,
    fence: null,
    data: {},
    source: null,
    source_version: null,
  };
}

const JAN_2025 = Date.UTC(2025, 0, 15);

// ---------------------------------------------------------------------------
// (a) Drain
// ---------------------------------------------------------------------------

describe("runSweep — drain loop", () => {
  it("fully drains a project with more than one page of expired artifacts", async () => {
    // 250 expired keys, page size 100 → needs 3 /sweep rounds (100, 100, 50).
    // A generous subrequest budget keeps this test focused on DRAIN, not the cap.
    const keys = Array.from({ length: 250 }, (_, i) => `produced/p1/k${i}.bin`);
    const { env } = makeWorld({ p1: { expiredKeys: [...keys] } });

    const summary = await runSweep(env, {
      projects: [{ projectId: "p1" }],
      drainPageSize: 100,
      subrequestBudget: 10_000,
    });

    expect(summary.artifactsExpired).toBe(250);
    const p1 = summary.projectStatuses.find((p) => p.projectId === "p1");
    expect(p1).toBeDefined();
    expect(p1?.expired).toBe(250);
    expect(p1?.remaining).toBe(0);
    expect(p1?.truncated).toBe(false);
    expect(p1?.status).toBe("ok");
  });

  it("reports per-project expired-vs-remaining in the summary", async () => {
    const keys = Array.from({ length: 5 }, (_, i) => `produced/p1/k${i}.bin`);
    const { env } = makeWorld({ p1: { expiredKeys: [...keys] } });

    const summary = await runSweep(env, {
      projects: [{ projectId: "p1" }],
      drainPageSize: 100,
    });

    const p1 = summary.projectStatuses.find((p) => p.projectId === "p1");
    expect(p1?.expired).toBe(5);
    expect(p1?.remaining).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// (b) Journal-archive safety
// ---------------------------------------------------------------------------

describe("runSweep — journal-archive key uniqueness", () => {
  it("writes distinct R2 keys for the same month across two runs (no overwrite)", async () => {
    // One world, one project DO. Run 1 archives seq 1..3 (Jan 2025); after the
    // confirm, fresh same-month events (seq 4..5) accrue; run 2 archives those.
    const world = makeWorld({
      p1: {
        expiredKeys: [],
        journalEvents: [evt(1, JAN_2025), evt(2, JAN_2025), evt(3, JAN_2025)],
      },
    });

    // --- Run 1 ---
    await runSweep(world.env, { projects: [{ projectId: "p1" }] });
    const afterRun1 = [...(world.r2PutOrder.get("p1") ?? [])];
    expect(afterRun1).toHaveLength(1);
    const run1Key = afterRun1[0];

    // New same-calendar-month events arrive after run 1's confirm.
    world.reseedJournal("p1", [evt(4, JAN_2025), evt(5, JAN_2025)]);

    // --- Run 2 ---
    await runSweep(world.env, { projects: [{ projectId: "p1" }] });
    const allKeys = world.r2PutOrder.get("p1") ?? [];
    // Two distinct objects now exist — run 2 did NOT overwrite run 1.
    expect(allKeys).toHaveLength(2);
    const run2Key = allKeys[1];

    expect(run2Key).not.toBe(run1Key);
    // Both share the same year/month prefix (collision avoided via throughSeq).
    expect(run1Key).toContain("2025/01");
    expect(run2Key).toContain("2025/01");
    // The R2 store retains both keys as separate objects.
    expect(world.r2Puts.get("p1")?.size).toBe(2);
    expect(world.r2Puts.get("p1")?.has(run1Key)).toBe(true);
    expect(world.r2Puts.get("p1")?.has(run2Key)).toBe(true);
  });

  it("archives events and advances the summary counter", async () => {
    const world = makeWorld({
      p1: {
        expiredKeys: [],
        journalEvents: [evt(1, JAN_2025), evt(2, JAN_2025)],
      },
    });

    const summary = await runSweep(world.env, {
      projects: [{ projectId: "p1" }],
    });

    expect(summary.journalEventsArchived).toBe(2);
    expect(world.archiveConfirms.get("p1")).toEqual([2]);
  });
});

// ---------------------------------------------------------------------------
// (c) Per-project status + isolation
// ---------------------------------------------------------------------------

describe("runSweep — per-project status and isolation", () => {
  it("marks a project degraded when its archive step fails", async () => {
    const { env } = makeWorld({
      p1: { expiredKeys: ["produced/p1/a.bin"], failOn: "archive" },
    });

    const summary = await runSweep(env, { projects: [{ projectId: "p1" }] });

    const p1 = summary.projectStatuses.find((p) => p.projectId === "p1");
    expect(p1?.status).toBe("degraded");
    expect(p1?.archive).toBe("error");
    // The expired-artifact sweep still ran before the archive failure.
    expect(p1?.sweep).toBe("ok");
    // A degraded project is NOT counted as fully swept.
    expect(summary.projectsSwept).toBe(0);
    expect(summary.projectsDegraded).toBe(1);
  });

  it("marks a project degraded when its R2 archive put fails", async () => {
    const { env } = makeWorld({
      p1: {
        expiredKeys: [],
        journalEvents: [evt(1, JAN_2025)],
        failOn: "archive-r2",
      },
    });

    const summary = await runSweep(env, { projects: [{ projectId: "p1" }] });
    const p1 = summary.projectStatuses.find((p) => p.projectId === "p1");
    expect(p1?.status).toBe("degraded");
    expect(p1?.archive).toBe("error");
    // R2 write failed → events must NOT be confirmed/deleted.
    expect(summary.journalEventsArchived).toBe(0);
  });

  it("isolates a failing project so siblings still complete", async () => {
    const { env } = makeWorld({
      p1: { expiredKeys: ["produced/p1/a.bin"], failOn: "sweep" },
      p2: { expiredKeys: ["produced/p2/a.bin", "produced/p2/b.bin"] },
      p3: { expiredKeys: ["produced/p3/a.bin"], failOn: "drift" },
    });

    const summary = await runSweep(env, {
      projects: [{ projectId: "p1" }, { projectId: "p2" }, { projectId: "p3" }],
    });

    // p1 (sweep throws) → degraded, but does NOT abort the run.
    const p1 = summary.projectStatuses.find((p) => p.projectId === "p1");
    expect(p1?.status).toBe("degraded");
    expect(p1?.sweep).toBe("error");

    // p2 is untouched by p1/p3 failures and fully completes.
    const p2 = summary.projectStatuses.find((p) => p.projectId === "p2");
    expect(p2?.status).toBe("ok");
    expect(p2?.expired).toBe(2);

    // p3 (drift throws) → degraded but the sweep itself succeeded.
    const p3 = summary.projectStatuses.find((p) => p.projectId === "p3");
    expect(p3?.status).toBe("degraded");
    expect(p3?.drift).toBe("error");
    expect(p3?.sweep).toBe("ok");

    // All three projects were attempted.
    expect(summary.projectStatuses).toHaveLength(3);
    expect(summary.projectsDegraded).toBe(2);
    expect(summary.projectsSwept).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// (d) Wall-clock budget + resume point
// ---------------------------------------------------------------------------

describe("runSweep — wall-clock budget", () => {
  it("stops cleanly and records a resume point when the budget is exhausted", async () => {
    // Three projects; advance the fake clock past the budget after p1.
    let nowMs = 0;
    const tick = () => {
      nowMs += 60; // each now() read advances 60ms
      return nowMs;
    };
    const { env } = makeWorld({
      p1: { expiredKeys: ["produced/p1/a.bin"] },
      p2: { expiredKeys: ["produced/p2/a.bin"] },
      p3: { expiredKeys: ["produced/p3/a.bin"] },
    });

    const summary = await runSweep(env, {
      projects: [{ projectId: "p1" }, { projectId: "p2" }, { projectId: "p3" }],
      now: tick,
      timeBudgetMs: 100, // exhausted partway through
    });

    // The run stopped while working p1 and recorded a resume frontier there.
    expect(summary.resumePoint).not.toBeNull();
    expect(summary.resumePoint?.projectId).toBe("p1");
    expect(summary.resumePoint?.phase).toBe("drain");

    // Only p1 was attempted; p2/p3 were not reached → fewer than all 3.
    expect(summary.projectStatuses.length).toBeLessThan(3);

    // p1 was truncated mid-drain: it carries pending work and its archive/drift
    // steps were skipped (not run past the budget).
    const p1 = summary.projectStatuses.find((p) => p.projectId === "p1");
    expect(p1?.remaining).toBeGreaterThan(0);
    expect(p1?.truncated).toBe(true);
    expect(p1?.archive).toBe("skipped");
    expect(p1?.drift).toBe("skipped");
  });

  it("has a null resume point when the whole run completes within budget", async () => {
    const { env } = makeWorld({
      p1: { expiredKeys: ["produced/p1/a.bin"] },
    });

    const summary = await runSweep(env, {
      projects: [{ projectId: "p1" }],
      timeBudgetMs: 60_000,
    });

    expect(summary.resumePoint).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// (e) Per-invocation subrequest budget (Cloudflare 1000-subrequest cap)
// ---------------------------------------------------------------------------

describe("runSweep — subrequest budget", () => {
  it("stops at the subrequest budget for a large backlog and records a resume point", async () => {
    // 5000 expired keys would cost ~15000 subrequests if fully drained — far
    // over the 1000 cap. The run must stop at the budget and resume next time.
    const keys = Array.from(
      { length: 5000 },
      (_, i) => `produced/p1/k${i}.bin`,
    );
    const world = makeWorld({ p1: { expiredKeys: [...keys] } });

    const summary = await runSweep(world.env, {
      projects: [{ projectId: "p1" }],
      subrequestBudget: 800,
    });

    // Stopped on the subrequest budget, with a resume frontier on p1.
    expect(summary.resumePoint).not.toBeNull();
    expect(summary.resumePoint?.projectId).toBe("p1");
    expect(summary.resumePoint?.phase).toBe("subrequest-budget");

    const p1 = summary.projectStatuses.find((p) => p.projectId === "p1");
    expect(p1?.truncated).toBe(true);
    expect(p1?.remaining).toBeGreaterThan(0);
    // It made real progress (drained some) before stopping.
    expect(p1?.expired).toBeGreaterThan(0);

    // CRITICAL: actual subrequests issued never crossed the Cloudflare cap.
    expect(world.meter.subrequests).toBeLessThanOrEqual(1000);
    // And stayed within the configured ceiling (checks are pre-increment).
    expect(world.meter.subrequests).toBeLessThanOrEqual(800);
  });

  it("counts subrequests ACROSS projects, not per-project", async () => {
    // Two projects each with a big backlog; the budget is shared, so the second
    // project must inherit the spent budget and not get a fresh 800.
    const mk = (p: string) =>
      Array.from({ length: 2000 }, (_, i) => `produced/${p}/k${i}.bin`);
    const world = makeWorld({
      p1: { expiredKeys: mk("p1") },
      p2: { expiredKeys: mk("p2") },
    });

    const summary = await runSweep(world.env, {
      projects: [{ projectId: "p1" }, { projectId: "p2" }],
      subrequestBudget: 800,
    });

    // The shared cap was hit inside p1, so p2 is never started (resume on p1).
    expect(summary.resumePoint?.projectId).toBe("p1");
    expect(world.meter.subrequests).toBeLessThanOrEqual(800);
    // p2 did not run at all.
    expect(
      summary.projectStatuses.find((p) => p.projectId === "p2"),
    ).toBeUndefined();
  });

  it("drains a backlog larger than one invocation across multiple runs", async () => {
    // 400 keys, budget 300 subrequests (~100 keys/run after overhead). Run the
    // sweep repeatedly against the SAME world until the backlog is cleared.
    const keys = Array.from({ length: 400 }, (_, i) => `produced/p1/k${i}.bin`);
    const world = makeWorld({ p1: { expiredKeys: [...keys] } });

    let runs = 0;
    let totalExpired = 0;
    let lastSummary = await runSweep(world.env, {
      projects: [{ projectId: "p1" }],
      subrequestBudget: 300,
      drainPageSize: 50,
    });
    runs++;
    totalExpired +=
      lastSummary.projectStatuses.find((p) => p.projectId === "p1")?.expired ??
      0;

    // Keep running until a run reports no resume point (backlog cleared).
    while (lastSummary.resumePoint !== null && runs < 20) {
      world.meter.subrequests = 0; // each run is a fresh invocation
      lastSummary = await runSweep(world.env, {
        projects: [{ projectId: "p1" }],
        subrequestBudget: 300,
        drainPageSize: 50,
      });
      runs++;
      totalExpired +=
        lastSummary.projectStatuses.find((p) => p.projectId === "p1")
          ?.expired ?? 0;
      // Every single invocation stayed under the cap.
      expect(world.meter.subrequests).toBeLessThanOrEqual(300);
    }

    // Backlog fully drained across multiple runs, each under the cap.
    expect(totalExpired).toBe(400);
    expect(lastSummary.resumePoint).toBeNull();
    expect(runs).toBeGreaterThan(1); // it genuinely took several invocations
  });
});

// ---------------------------------------------------------------------------
// (f) Iteration-clamp isolation (degrades the project, does NOT abort the run)
// ---------------------------------------------------------------------------

describe("runSweep — drain iteration clamp", () => {
  it("marks only the clamped project degraded and continues to siblings", async () => {
    // p1's tombstone is a no-op, so /sweep keeps returning a full page forever
    // → the iteration clamp trips. p2 is healthy and must still complete.
    const fullPage = Array.from(
      { length: 150 },
      (_, i) => `produced/p1/k${i}.bin`,
    );
    const { env } = makeWorld({
      p1: { expiredKeys: [...fullPage], failOn: "tombstone-noop" },
      p2: { expiredKeys: ["produced/p2/a.bin"] },
    });

    const summary = await runSweep(env, {
      projects: [{ projectId: "p1" }, { projectId: "p2" }],
      drainPageSize: 150,
      subrequestBudget: 100_000, // ensure the CLAMP trips, not the budget
    });

    const p1 = summary.projectStatuses.find((p) => p.projectId === "p1");
    expect(p1?.status).toBe("degraded");
    expect(p1?.sweep).toBe("error");
    expect(p1?.truncated).toBe(true);

    // The clamp must NOT set a run-aborting resume point.
    expect(summary.resumePoint).toBeNull();

    // p2 still ran to completion despite p1's clamp.
    const p2 = summary.projectStatuses.find((p) => p.projectId === "p2");
    expect(p2?.status).toBe("ok");
    expect(p2?.expired).toBe(1);
    expect(summary.projectStatuses).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// (g) Test edges: drift reconcile + zero-work no-op
// ---------------------------------------------------------------------------

describe("runSweep — drift and no-op edges", () => {
  it("reconciles a project whose drift findings exceed the threshold", async () => {
    const { env } = makeWorld({
      p1: {
        expiredKeys: [],
        driftFindings: [{ check: "orphan_docs", count: 25, status: "fail" }],
      },
    });

    const summary = await runSweep(env, { projects: [{ projectId: "p1" }] });

    expect(summary.driftChecksRun).toBe(1);
    expect(summary.driftReconciled).toBe(1);
    const p1 = summary.projectStatuses.find((p) => p.projectId === "p1");
    expect(p1?.status).toBe("ok");
    expect(p1?.drift).toBe("ok");
  });

  it("handles a zero-work project as a clean no-op", async () => {
    // No expired keys, no journal events, no drift findings.
    const { env } = makeWorld({ p1: { expiredKeys: [] } });

    const summary = await runSweep(env, { projects: [{ projectId: "p1" }] });

    const p1 = summary.projectStatuses.find((p) => p.projectId === "p1");
    expect(p1?.status).toBe("ok");
    expect(p1?.expired).toBe(0);
    expect(p1?.remaining).toBe(0);
    expect(p1?.truncated).toBe(false);
    expect(p1?.sweep).toBe("ok");
    expect(p1?.archive).toBe("ok"); // no events → clean no-op, still "ok"
    expect(p1?.drift).toBe("ok");
    expect(summary.projectsSwept).toBe(1);
    expect(summary.projectsDegraded).toBe(0);
    expect(summary.resumePoint).toBeNull();
    expect(summary.artifactsExpired).toBe(0);
    expect(summary.journalEventsArchived).toBe(0);
  });
});
