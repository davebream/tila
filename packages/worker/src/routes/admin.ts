import { D1ProjectRegistry, D1RevokedJtiStore } from "@tila/backend-d1";
import { R2ArtifactBackend } from "@tila/backend-r2";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { forwardToDO } from "../lib/do-forward";
import { revokeJtiInCache } from "../middleware/auth";
import { requirePermission } from "../middleware/permission";
import type { Env, HonoVariables } from "../types";

type AdminEnv = { Bindings: Env; Variables: HonoVariables };

/**
 * Guards destroy/store-counts routes so only full-scope D1 API tokens
 * can reach them. GitHub session tokens (kind "session") with
 * permission==="admin" pass requirePermission("admin") but must not be
 * allowed to trigger destructive infra-owner operations.
 */
export const requireD1Token: MiddlewareHandler<AdminEnv> = async (c, next) => {
  const tokenResult = c.get("tokenResult");
  if (tokenResult.kind !== "d1-token") {
    return c.json(
      {
        ok: false,
        error: {
          code: "D1_TOKEN_REQUIRED",
          message: "This operation requires a full-scope D1 API token",
          retryable: false,
        },
      },
      403,
    );
  }
  return next();
};

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

interface ArchiveResponse {
  ok: boolean;
  events: JournalEvent[];
  throughSeq: number;
  count: number;
}

interface ConfirmResponse {
  ok: boolean;
  watermark: { lastArchivedSeq: number; archivedAt: number } | null;
}

/**
 * Write journal events to R2 as JSONL files grouped by year/month.
 * Key format: journal-archive/<projectId>/<year>/<month>.jsonl
 */
async function writeJournalArchiveToR2(
  r2: R2Bucket,
  events: JournalEvent[],
  projectId: string,
): Promise<void> {
  // Group events by year/month based on their timestamp
  const groups = new Map<string, JournalEvent[]>();
  for (const event of events) {
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

  for (const [yearMonth, groupEvents] of groups) {
    const r2Key = `journal-archive/${projectId}/${yearMonth}.jsonl`;
    const jsonl = groupEvents.map((e) => JSON.stringify(e)).join("\n");
    await r2.put(r2Key, jsonl);
  }
}

export const admin = new Hono<AdminEnv>();

admin.post("/restart", requirePermission("admin"), async (c) => {
  const stub = c.get("doStub");
  return forwardToDO(stub, "/admin/restart", "POST");
});

admin.post("/archive/journal", requirePermission("admin"), async (c) => {
  const stub = c.get("doStub");
  const projectId = c.get("projectId");

  // Step 1: Get archivable events from the DO
  const archiveRes = await forwardToDO(stub, "/journal/archive", "POST");
  if (!archiveRes.ok) {
    return c.json(
      {
        ok: false,
        error: {
          code: "DO_ERROR",
          message: "Failed to fetch archivable events",
        },
      },
      502,
    );
  }

  const archiveData = (await archiveRes.json()) as ArchiveResponse;

  // Step 2: If nothing to archive, return early
  if (archiveData.count === 0) {
    return c.json({ ok: true, archived: 0 });
  }

  // Step 3: Write events to R2 grouped by year/month
  try {
    await writeJournalArchiveToR2(
      c.env.ARTIFACTS,
      archiveData.events,
      projectId,
    );
  } catch (err) {
    console.error(`[archive] R2 write failed for project ${projectId}:`, err);
    return c.json(
      {
        ok: false,
        error: { code: "R2_ERROR", message: "Failed to write archive to R2" },
      },
      502,
    );
  }

  // Step 4: Confirm archival on DO (watermark advances + rows deleted)
  const confirmRes = await forwardToDO(
    stub,
    "/journal/archive/confirm",
    "POST",
    {
      throughSeq: archiveData.throughSeq,
    },
  );

  if (!confirmRes.ok) {
    console.error(
      `[archive] confirm failed for project ${projectId}, R2 already written`,
    );
    return c.json(
      {
        ok: false,
        error: {
          code: "CONFIRM_ERROR",
          message: "R2 write succeeded but DO confirm failed",
        },
      },
      502,
    );
  }

  const confirmData = (await confirmRes.json()) as ConfirmResponse;

  return c.json({
    ok: true,
    archived: archiveData.count,
    throughSeq: archiveData.throughSeq,
    watermark: confirmData.watermark,
  });
});

/**
 * GET /admin/store-counts
 * Returns per-table row counts from the project's DO (for destroy read-back
 * verification). Requires a full-scope D1 API token — GitHub session tokens
 * with admin permission are explicitly rejected.
 */
admin.get(
  "/store-counts",
  requirePermission("admin"),
  requireD1Token,
  async (c) => {
    const stub = c.get("doStub");
    return forwardToDO(stub, "/admin/store-counts", "GET");
  },
);

/**
 * POST /admin/destroy
 *
 * Orchestrates a full project destroy:
 *   1. Read target pointer keys from DO (DO is still live).
 *   2. Reference-counted R2 GC: fetch all other projects' keys (including
 *      archived — listAllIncludingArchived prevents deleting blobs an archived
 *      project still references). Delete only keys absent from the live union.
 *      Re-head each key immediately before deletion to narrow the
 *      concurrent-adoption race window.
 *   3. Delete journal-archive/<projectId>/ prefix.
 *   4. POST /admin/destroy to DO (last — deleteAll+abort).
 *   5. Probe store-counts on the reconstructed DO to derive doWiped.
 *
 * Subrequest counter ceiling: ~800 (leaves headroom for DO wipe + journal
 * delete + the post-destroy store-counts probe). Budget is dominated by cold
 * DO wakes for peer pointer-key fetches. If the ceiling is reached, R2
 * content-blob GC is skipped (r2GcSkipped: true); DO wipe + journal delete
 * always run.
 *
 * Note: keys read from peer DOs are used transiently for the union computation
 * only; they are never written or retained beyond this request. (RC-8)
 */
const SUBREQUEST_CEILING = 800;

admin.post(
  "/destroy",
  requirePermission("admin"),
  requireD1Token,
  async (c) => {
    const stub = c.get("doStub");
    const projectId = c.get("projectId");
    const r2 = new R2ArtifactBackend(c.env.ARTIFACTS);
    const registry = new D1ProjectRegistry(c.env.DB);

    let subrequestCount = 0;
    let r2GcSkipped = false;
    let r2Deleted = 0;
    let r2Kept = 0;
    let r2Failed = 0;
    let journalDeleted = 0;

    // ── Step 1: Read target project's pointer keys ──────────────────────────
    subrequestCount++;
    const targetKeysRes = await forwardToDO(stub, "/admin/pointer-keys", "GET");
    if (!targetKeysRes.ok) {
      return c.json(
        {
          ok: false,
          error: {
            code: "POINTER_KEYS_FETCH_FAILED",
            message: "Failed to read target project pointer keys",
          },
        },
        502,
      );
    }
    const { keys: targetKeys } = (await targetKeysRes.json()) as {
      keys: string[];
    };

    // ── Step 2: Reference-counted R2 GC ────────────────────────────────────
    // Fetch pointer keys for every other project (including archived) to build
    // the live-key union. A key is only deleted if absent from this union.
    const allProjects = await registry.listAllIncludingArchived();
    const otherProjects = allProjects.filter((p) => p.projectId !== projectId);

    const liveKeyUnion = new Set<string>();

    for (const { projectId: otherId } of otherProjects) {
      if (subrequestCount >= SUBREQUEST_CEILING) {
        // r2GcSkipped = true here means r2Kept reflects union-diff candidates
        // only (not a refcount-retention guarantee) and r2Deleted may be 0
        // because deleteMany is skipped — the DO wipe and journal delete still run.
        r2GcSkipped = true;
        break;
      }
      subrequestCount++;
      const otherDoId = c.env.PROJECT.idFromName(otherId);
      const otherStub = c.env.PROJECT.get(otherDoId);
      // Pass NO analytics context to peer fetches — a destroy of one project
      // must not emit analytics datapoints attributed to others. (RC-4)
      const res = await forwardToDO(otherStub, "/admin/pointer-keys", "GET");
      if (!res.ok) {
        // Fail GC rather than under-count the union — under-counting risks
        // deleting blobs another project needs (data corruption).
        return c.json(
          {
            ok: false,
            error: {
              code: "PEER_POINTER_KEYS_FETCH_FAILED",
              message: `Failed to read pointer keys for project ${otherId}`,
            },
          },
          502,
        );
      }
      const { keys: peerKeys } = (await res.json()) as { keys: string[] };
      for (const key of peerKeys) {
        liveKeyUnion.add(key);
      }
    }

    if (!r2GcSkipped) {
      // Determine which keys to delete: target keys NOT in the live union
      const toDelete = targetKeys.filter((k) => !liveKeyUnion.has(k));
      r2Kept = targetKeys.length - toDelete.length;

      // Re-head each candidate key immediately before deleting to narrow the
      // concurrent-adoption race window. Skip keys that are no longer in R2.
      const confirmedToDelete: string[] = [];
      for (const key of toDelete) {
        if (subrequestCount >= SUBREQUEST_CEILING) {
          r2GcSkipped = true;
          break;
        }
        subrequestCount++;
        const headResult = await r2.head(key);
        if (headResult !== null) {
          confirmedToDelete.push(key);
        }
      }

      if (confirmedToDelete.length > 0 && !r2GcSkipped) {
        subrequestCount++; // conservative count for the deleteMany batch
        const deleteResult = await r2.deleteMany(confirmedToDelete);
        r2Deleted = deleteResult.deleted;
        r2Failed = deleteResult.failed.length;
      }
    }

    // ── Step 3: Delete journal-archive prefix ───────────────────────────────
    subrequestCount++; // budget for the prefix delete (may paginate internally)
    const journalResult = await r2.deleteByPrefix(
      `journal-archive/${projectId}/`,
    );
    journalDeleted = journalResult.deleted;

    // ── Step 4: Destroy the DO (LAST) ───────────────────────────────────────
    // ok-then-disconnect = durable wipe (abort() severs the connection).
    // A returned non-ok body is a real failure (deleteAll() threw before abort).
    let destroyOk = false;
    try {
      const destroyRes = await forwardToDO(stub, "/admin/destroy", "POST");
      if (!destroyRes.ok) {
        const errBody = (await destroyRes.json()) as {
          error?: { code?: string };
        };
        return c.json(
          {
            ok: false,
            error: {
              code: errBody?.error?.code ?? "DO_DESTROY_FAILED",
              message: "DO destroy returned a non-ok response",
            },
            journalDeleted,
            r2Deleted,
            r2Kept,
            r2Failed,
            r2GcSkipped,
          },
          502,
        );
      }
      destroyOk = true;
    } catch {
      // Connection severed after abort() — treat as a durable wipe.
      // The authoritative check is the store-counts read-back below.
      destroyOk = true;
    }

    // ── Step 5: Probe store-counts on reconstructed DO ──────────────────────
    // doWiped is NEVER hardcoded — it is derived from the read-back.
    // The DO reconstruct re-runs migrations in blockConcurrencyWhile, yielding
    // an empty schema (domain tables all zero; _schema_history may have rows).
    let doWiped = false;
    if (destroyOk) {
      try {
        const countsRes = await forwardToDO(stub, "/admin/store-counts", "GET");
        if (countsRes.ok) {
          const { counts } = (await countsRes.json()) as {
            counts: { domain: Record<string, number>; schemaHistory: number };
          };
          const domainValues = Object.values(counts.domain ?? {});
          doWiped =
            domainValues.length > 0 && domainValues.every((v) => v === 0);
        }
      } catch {
        // store-counts probe failed — doWiped stays false
      }
    }

    return c.json({
      ok: true,
      doWiped,
      journalDeleted,
      r2Deleted,
      r2Kept,
      r2Failed,
      r2GcSkipped,
    });
  },
);

/**
 * POST /admin/sessions/revoke
 *
 * Admin-plane endpoint (C9) to revoke a session JWT by jti.
 * Guarded by requirePermission("admin") per flow-separation.md.
 *
 * Body: { jti: string }
 *
 * Inserts the jti into the D1 _revoked_jti table and immediately
 * invalidates the per-isolate cache entry in the revoking isolate.
 * Cross-isolate staleness: ≤ JTI_REVCHECK_TTL_MS (default 60s).
 */
admin.post("/sessions/revoke", requirePermission("admin"), async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json(
      {
        ok: false,
        error: {
          code: "VALIDATION_ERROR",
          message: "Invalid JSON body",
          retryable: false,
        },
      },
      400,
    );
  }

  if (
    typeof body !== "object" ||
    body === null ||
    typeof (body as Record<string, unknown>).jti !== "string" ||
    !(body as Record<string, unknown>).jti
  ) {
    return c.json(
      {
        ok: false,
        error: {
          code: "VALIDATION_ERROR",
          message: "Body must include a non-empty jti string",
          retryable: false,
        },
      },
      400,
    );
  }

  const jti = (body as { jti: string }).jti;
  const projectId = c.get("projectId") ?? "";

  // 1. Persist to D1
  const store = new D1RevokedJtiStore(c.env.DB);
  await store.revoke(jti, projectId);

  // 2. Immediately invalidate in the revoking isolate's cache
  revokeJtiInCache(jti);

  return c.json({ ok: true, jti, revoked_at: Date.now() });
});
