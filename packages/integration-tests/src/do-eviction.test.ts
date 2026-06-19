/**
 * DO-state survival integration test (env-gated pre-tag gate).
 *
 * Verifies that Durable Object SQLite state survives an eviction+restart cycle.
 * This catches any regression where state is held in memory only (not written
 * to DO SQLite).
 *
 * Gate requirements:
 * - TILA_BASE_URL — live worker URL (e.g. https://your-worker.workers.dev)
 * - TILA_TOKEN    — an **admin-scoped** token (POST /admin/restart requires
 *                   requirePermission("admin")); a 403 response means the token
 *                   is not admin-scoped — use `tila token create --scope admin`
 *
 * Optional:
 * - TILA_PROJECT_ID — defaults to "dev-project"
 *
 * These tests are intentionally skipped in CI (no live infrastructure). Run them
 * manually before each release tag as documented in OSS-RELEASE-RUNBOOK.md §7.1
 * and in docs/05-OPERATIONS.md.
 *
 * Assertions:
 * - Hard: task written before restart is readable with correct data after restart
 * - Tolerant: post-restart read latency must be within a soft budget (cold-start
 *             variance allowed; failure is advisory, not blocking)
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const BASE_URL = process.env.TILA_BASE_URL;
const TOKEN = process.env.TILA_TOKEN;
const PROJECT_ID = process.env.TILA_PROJECT_ID ?? "dev-project";

/** Cold-start latency budget in milliseconds (soft — advisory only). */
const COLD_START_BUDGET_MS = 5_000;

/** Number of read attempts for best-of-N latency check. */
const LATENCY_SAMPLE_COUNT = 3;

const auth = { Authorization: `Bearer ${TOKEN}` } as Record<string, string>;
const stamp = Date.now();
const evictionTaskId = `T-do-eviction-${stamp}`;

describe.skipIf(!BASE_URL || !TOKEN)(
  "DO-state survival after restart (env-gated pre-tag gate)",
  () => {
    beforeAll(async () => {
      // Write a task before the eviction cycle so we can verify it survives.
      const res = await fetch(`${BASE_URL}/projects/${PROJECT_ID}/tasks`, {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify({
          id: evictionTaskId,
          type: "task",
          data: { title: "do-eviction-probe" },
          created_by: "do-eviction-test",
        }),
      });
      // 200 = created, 409 = already exists (idempotent retry) — both fine
      expect(res.status).toSatisfy(
        (s: number) => s === 200 || s === 409,
        `Expected 200 or 409 creating eviction task, got ${res.status}`,
      );
    });

    afterAll(async () => {
      // Best-effort cleanup — ignore errors (task may not have a fence to delete)
      try {
        await fetch(
          `${BASE_URL}/projects/${PROJECT_ID}/tasks/${evictionTaskId}`,
          { method: "DELETE", headers: auth },
        );
      } catch {
        // Ignore cleanup failures — the task has a unique timestamp-stamped ID
      }
    });

    it("POST /admin/restart returns 200 (admin-scoped token required)", async () => {
      const res = await fetch(
        `${BASE_URL}/projects/${PROJECT_ID}/admin/restart`,
        { method: "POST", headers: auth },
      );

      if (res.status === 403) {
        throw new Error(
          "POST /admin/restart returned 403 — TILA_TOKEN must be admin-scoped.\n" +
            "Create an admin token with: tila token create --scope admin\n" +
            "Then set TILA_TOKEN to that value and re-run.",
        );
      }

      expect(res.status).toBe(200);
    });

    it("task data survives DO eviction+restart (hard assert — state must be persisted)", async () => {
      const res = await fetch(
        `${BASE_URL}/projects/${PROJECT_ID}/tasks/${evictionTaskId}`,
        { headers: auth },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        ok: boolean;
        entity?: { id: string; data?: { title?: string } };
        task?: { id: string; data?: { title?: string } };
      };
      expect(body.ok).toBe(true);
      // Support both 'entity' (internal) and 'task' (public API) response shapes
      const item = body.entity ?? body.task;
      expect(item).toBeDefined();
      expect(item?.id).toBe(evictionTaskId);
      expect(item?.data?.title).toBe("do-eviction-probe");
    });

    it("post-restart read latency is within cold-start budget (soft — advisory only)", async () => {
      // best-of-N latency: take the minimum RTT across LATENCY_SAMPLE_COUNT reads
      const latencies: number[] = [];

      for (let i = 0; i < LATENCY_SAMPLE_COUNT; i++) {
        const start = Date.now();
        const res = await fetch(
          `${BASE_URL}/projects/${PROJECT_ID}/tasks/${evictionTaskId}`,
          { headers: auth },
        );
        const elapsed = Date.now() - start;
        if (res.status === 200) {
          latencies.push(elapsed);
        }
      }

      if (latencies.length === 0) {
        // If every read failed we already have a hard failure above — skip advisory
        return;
      }

      const bestLatency = Math.min(...latencies);
      // Advisory only: log the result but do not fail the test run
      if (bestLatency > COLD_START_BUDGET_MS) {
        console.warn(
          `[do-eviction] ADVISORY: best-of-${LATENCY_SAMPLE_COUNT} post-restart latency ${bestLatency}ms exceeds soft budget ${COLD_START_BUDGET_MS}ms. This may indicate an unusually slow cold-start or a flaky network — investigate if consistently high.`,
        );
      }
      // Always pass — latency budget is advisory
      expect(bestLatency).toBeGreaterThanOrEqual(0);
    });
  },
);
