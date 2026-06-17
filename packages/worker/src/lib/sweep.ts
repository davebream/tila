import { D1ProjectRegistry, D1SessionStore } from "@tila/backend-d1";
import { R2ArtifactBackend } from "@tila/backend-r2";
import { DRIFT_RECONCILE_THRESHOLD, SWEEP_BATCH_SIZE } from "../config";
import type { Env } from "../types";
import { sweepExpiredKey } from "./sweep-key";

export interface SweepSummary {
  projectsSwept: number;
  artifactsExpired: number;
  r2DeleteErrors: number;
  driftChecksRun: number;
  driftReconciled: number;
  driftErrors: number;
  expiredSessions: number;
  journalEventsArchived: number;
}

export async function runSweep(env: Env): Promise<SweepSummary> {
  console.log("[sweep] daily artifact cleanup started");
  const registry = new D1ProjectRegistry(env.DB);
  const r2 = new R2ArtifactBackend(env.ARTIFACTS);
  const projects = await registry.listAll();
  const summary: SweepSummary = {
    projectsSwept: 0,
    artifactsExpired: 0,
    r2DeleteErrors: 0,
    driftChecksRun: 0,
    driftReconciled: 0,
    driftErrors: 0,
    expiredSessions: 0,
    journalEventsArchived: 0,
  };

  // Session expiry cleanup (global, not per-project)
  try {
    const sessionStore = new D1SessionStore(env.DB);
    const { deleted: expiredSessions } = await sessionStore.deleteExpired();
    console.log(`[sweep] deleted ${expiredSessions} expired sessions`);
    summary.expiredSessions = expiredSessions;
  } catch (err) {
    console.error("[sweep] session cleanup failed:", err);
  }

  for (const { projectId } of projects) {
    const doId = env.PROJECT.idFromName(projectId);
    const doStub = env.PROJECT.get(doId);
    let res: Response;
    try {
      res = await doStub.fetch("http://do/sweep", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ batch_size: SWEEP_BATCH_SIZE }),
      });
    } catch (err) {
      console.error(
        `[sweep] failed to reach DO for project ${projectId}:`,
        err,
      );
      continue;
    }

    if (!res.ok) {
      console.error(
        `[sweep] DO /sweep returned ${res.status} for project ${projectId}`,
      );
      continue;
    }

    const data = (await res.json()) as { expiredKeys?: string[] };
    for (const key of data.expiredKeys ?? []) {
      await sweepExpiredKey(key, doStub, (k) => r2.delete(k), summary);
    }
    summary.projectsSwept++;

    // Journal archival: archive old journal events to R2 (non-fatal)
    try {
      const archiveRes = await doStub.fetch("http://do/journal/archive", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      if (archiveRes.ok) {
        const archiveData = (await archiveRes.json()) as {
          ok: boolean;
          events?: Array<{
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
          }>;
          throughSeq?: number;
          count?: number;
        };
        const count = archiveData.count ?? 0;
        if (
          count > 0 &&
          archiveData.events &&
          archiveData.throughSeq !== undefined
        ) {
          // Group events by year/month, write each group to R2 as JSONL
          const groups = new Map<string, typeof archiveData.events>();
          for (const event of archiveData.events) {
            const d = new Date(event.t);
            const year = d.getUTCFullYear();
            const month = String(d.getUTCMonth() + 1).padStart(2, "0");
            const key = `${year}/${month}`;
            const group = groups.get(key);
            if (group) {
              group.push(event);
            } else {
              groups.set(key, [event]);
            }
          }
          let r2WriteOk = true;
          for (const [yearMonth, groupEvents] of groups) {
            const r2Key = `journal-archive/${projectId}/${yearMonth}.jsonl`;
            const jsonl = groupEvents.map((e) => JSON.stringify(e)).join("\n");
            try {
              await env.ARTIFACTS.put(r2Key, jsonl);
            } catch (r2Err) {
              console.error(
                `[sweep] journal R2 write failed for ${r2Key}:`,
                r2Err,
              );
              r2WriteOk = false;
            }
          }
          if (r2WriteOk) {
            // Confirm archival so DO deletes events and advances watermark
            const confirmRes = await doStub.fetch(
              "http://do/journal/archive/confirm",
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ throughSeq: archiveData.throughSeq }),
              },
            );
            if (confirmRes.ok) {
              console.log(
                `[sweep] project ${projectId} archived ${count} journal events`,
              );
              summary.journalEventsArchived += count;
            } else {
              console.error(
                `[sweep] journal confirm failed for project ${projectId}: ${confirmRes.status}`,
              );
            }
          }
        }
      } else {
        console.error(
          `[sweep] journal archive request failed for project ${projectId}: ${archiveRes.status}`,
        );
      }
    } catch (archiveErr) {
      console.error(
        `[sweep] journal archival failed for project ${projectId}:`,
        archiveErr,
      );
    }

    // Search drift check + conditional reconciliation (non-fatal)
    try {
      const driftRes = await doStub.fetch("http://do/artifact/search-drift");
      if (driftRes.ok) {
        const drift = (await driftRes.json()) as {
          findings?: Array<{ check: string; count: number; status: string }>;
        };
        const findings = drift.findings ?? [];

        // Always log all 5 drift checks (even when count=0)
        console.log(
          `[sweep] project ${projectId} drift metrics:`,
          JSON.stringify(
            findings.map((f) => ({
              check: f.check,
              count: f.count,
              status: f.status,
            })),
          ),
        );
        summary.driftChecksRun++;

        // Sum fail-check counts and compare to threshold
        const totalFailCount = findings
          .filter((f) => f.status === "fail")
          .reduce((sum, f) => sum + f.count, 0);

        if (totalFailCount >= DRIFT_RECONCILE_THRESHOLD) {
          console.log(
            `[sweep] project ${projectId} drift threshold exceeded (${totalFailCount} >= ${DRIFT_RECONCILE_THRESHOLD}), triggering reconciliation`,
          );
          try {
            // Step 1: Get rebuild candidates
            const scanRes = await doStub.fetch(
              "http://do/artifact/search-rebuild-scan",
            );
            if (!scanRes.ok) {
              throw new Error(`search-rebuild-scan returned ${scanRes.status}`);
            }
            const scanData = (await scanRes.json()) as {
              ok: boolean;
              pointers: Array<unknown>;
            };

            // Step 2: Apply rebuild
            const rebuildRes = await doStub.fetch(
              "http://do/artifact/search-rebuild",
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  candidates: scanData.pointers,
                  apply: true,
                  actor: "sweep-cron",
                }),
              },
            );
            if (!rebuildRes.ok) {
              throw new Error(`search-rebuild returned ${rebuildRes.status}`);
            }
            console.log(
              `[sweep] project ${projectId} reconciliation completed successfully`,
            );
            summary.driftReconciled++;
          } catch (reconcileErr) {
            console.error(
              `[sweep] project ${projectId} reconciliation failed:`,
              reconcileErr,
            );
            summary.driftErrors++;
          }
        }
      }
    } catch (driftErr) {
      console.error(
        `[sweep] project ${projectId} drift check failed:`,
        driftErr,
      );
      summary.driftErrors++;
    }
  }

  console.log("[sweep] completed:", JSON.stringify(summary));
  return summary;
}
