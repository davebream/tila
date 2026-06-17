import { D1RevokedJtiStore } from "@tila/backend-d1";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import { destroyProjectResources } from "../lib/destroy-project";
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
const RevokeSessionRequestSchema = z.object({
  jti: z.string().uuid().max(64),
});

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
 * Per-project entry point to the shared destroy orchestration
 * (see lib/destroy-project.ts). Authenticated by a per-project full-scope D1
 * token. The infra-owner entry point (POST /_internal/projects/:id/destroy)
 * runs the SAME orchestration under a different auth model.
 */
admin.post(
  "/destroy",
  requirePermission("admin"),
  requireD1Token,
  async (c) => {
    const stub = c.get("doStub");
    const projectId = c.get("projectId");
    const result = await destroyProjectResources(c.env, stub, projectId);
    return c.json(result.body, result.status as ContentfulStatusCode);
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

  const parsed = RevokeSessionRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      {
        ok: false,
        error: {
          code: "VALIDATION_ERROR",
          message: "Body must include a UUID jti no longer than 64 characters",
          retryable: false,
        },
      },
      400,
    );
  }

  const { jti } = parsed.data;
  const projectId = c.get("projectId") ?? "";

  // 1. Persist to D1
  const store = new D1RevokedJtiStore(c.env.DB);
  await store.revoke(jti, projectId);

  // 2. Immediately invalidate in the revoking isolate's cache
  revokeJtiInCache(jti);

  return c.json({ ok: true, jti, revoked_at: Date.now() });
});
