import { D1RevokedJtiStore } from "@tila/backend-d1";
import { revokeJtiInCache } from "../middleware/auth";
import type { Env } from "../types";
import { forwardToDO } from "./do-forward";

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

export interface AdminOpResult {
  status: number;
  body: Record<string, unknown>;
}

/**
 * Orchestrate a journal archive. Shared by the per-project admin route
 * (POST /projects/:id/admin/archive/journal) and the infra-owner route —
 * both run the identical 4-step orchestration; they differ only in how the
 * caller is authenticated.
 *
 *   1. Fetch archivable events from the DO.
 *   2. If nothing to archive, return early ({ ok: true, archived: 0 }).
 *   3. Write events to R2 grouped by year/month.
 *   4. Confirm archival on the DO (watermark advances + rows deleted).
 *
 * Returns a context-free { status, body } pair — the caller maps it to a
 * response. Three distinct 502 paths: DO fetch failure (DO_ERROR), R2 write
 * failure (R2_ERROR), and DO confirm failure (CONFIRM_ERROR).
 */
export async function archiveJournal(
  env: Env,
  stub: DurableObjectStub,
  projectId: string,
): Promise<AdminOpResult> {
  // Step 1: Get archivable events from the DO
  const archiveRes = await forwardToDO(stub, "/journal/archive", "POST");
  if (!archiveRes.ok) {
    return {
      status: 502,
      body: {
        ok: false,
        error: {
          code: "do-error",
          message: "Failed to fetch archivable events",
        },
      },
    };
  }

  const archiveData = (await archiveRes.json()) as ArchiveResponse;

  // Step 2: If nothing to archive, return early
  if (archiveData.count === 0) {
    return { status: 200, body: { ok: true, archived: 0 } };
  }

  // Step 3: Write events to R2 grouped by year/month
  try {
    await writeJournalArchiveToR2(env.ARTIFACTS, archiveData.events, projectId);
  } catch (err) {
    console.error(`[archive] R2 write failed for project ${projectId}:`, err);
    return {
      status: 502,
      body: {
        ok: false,
        error: { code: "r2-error", message: "Failed to write archive to R2" },
      },
    };
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
    return {
      status: 502,
      body: {
        ok: false,
        error: {
          code: "confirm-error",
          message: "R2 write succeeded but DO confirm failed",
        },
      },
    };
  }

  const confirmData = (await confirmRes.json()) as ConfirmResponse;

  return {
    status: 200,
    body: {
      ok: true,
      archived: archiveData.count,
      throughSeq: archiveData.throughSeq,
      watermark: confirmData.watermark,
    },
  };
}

/**
 * Revoke a session JWT by jti. Shared by the per-project admin route
 * (POST /projects/:id/admin/sessions/revoke) and a later infra-owner route.
 *
 * Persists the jti to the D1 `_revoked_jti` table and immediately invalidates
 * the per-isolate cache entry in the revoking isolate. Cross-isolate staleness:
 * ≤ JTI_REVCHECK_TTL_MS (default 60s).
 *
 * CI-2: `assertedSlug` is recorded as-is (caller-asserted provenance). There is
 * NO jti→project derivation. The caller is responsible for parsing/validating
 * the jti before calling this helper.
 */
export async function revokeSession(
  env: Env,
  jti: string,
  assertedSlug: string,
): Promise<{ ok: true; jti: string; revoked_at: number }> {
  // 1. Persist to D1
  const store = new D1RevokedJtiStore(env.DB);
  await store.revoke(jti, assertedSlug);

  // 2. Immediately invalidate in the revoking isolate's cache
  revokeJtiInCache(jti);

  return { ok: true, jti, revoked_at: Date.now() };
}
