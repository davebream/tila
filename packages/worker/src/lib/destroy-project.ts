import { D1ProjectRegistry } from "@tila/backend-d1";
import { R2ArtifactBackend } from "@tila/backend-r2";
import type { Env } from "../types";
import { forwardToDO } from "./do-forward";

/**
 * Subrequest counter ceiling for a destroy. Leaves headroom for the DO wipe +
 * journal delete + the post-destroy store-counts probe. Budget is dominated by
 * cold DO wakes for peer pointer-key fetches. If the ceiling is reached, R2
 * content-blob GC is skipped (r2GcSkipped: true); DO wipe + journal delete
 * always run.
 */
const SUBREQUEST_CEILING = 800;

export interface DestroyResult {
  status: number;
  body: Record<string, unknown>;
}

/**
 * Orchestrate a full project destroy. Shared by the per-project admin route
 * (POST /projects/:id/admin/destroy) and the infra-owner route
 * (POST /_internal/admin/projects/:projectId/destroy) — both wipe identically; they differ
 * only in how the caller is authenticated.
 *
 *   1. Read target pointer keys from the DO (still live).
 *   2. Reference-counted R2 GC: fetch every other project's keys (including
 *      archived) to build the live-key union; delete only keys absent from it.
 *      Re-head each key immediately before deletion to narrow the
 *      concurrent-adoption race window.
 *   3. Delete journal-archive/<projectId>/ prefix.
 *   4. POST /admin/destroy to the DO (last — deleteAll + abort).
 *   5. Probe store-counts on the reconstructed DO to derive doWiped.
 *
 * Note: keys read from peer DOs are used transiently for the union computation
 * only; they are never written or retained beyond this call. (RC-8)
 */
export async function destroyProjectResources(
  env: Env,
  stub: DurableObjectStub,
  projectId: string,
): Promise<DestroyResult> {
  const r2 = new R2ArtifactBackend(env.ARTIFACTS);
  const registry = new D1ProjectRegistry(env.DB);

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
    return {
      status: 502,
      body: {
        ok: false,
        error: {
          code: "POINTER_KEYS_FETCH_FAILED",
          message: "Failed to read target project pointer keys",
        },
      },
    };
  }
  const { keys: targetKeys } = (await targetKeysRes.json()) as {
    keys: string[];
  };

  // ── Step 2: Reference-counted R2 GC ────────────────────────────────────
  const allProjects = await registry.listAllIncludingArchived();
  const otherProjects = allProjects.filter((p) => p.projectId !== projectId);

  const liveKeyUnion = new Set<string>();

  for (const { projectId: otherId } of otherProjects) {
    if (subrequestCount >= SUBREQUEST_CEILING) {
      r2GcSkipped = true;
      break;
    }
    subrequestCount++;
    const otherDoId = env.PROJECT.idFromName(otherId);
    const otherStub = env.PROJECT.get(otherDoId);
    const res = await forwardToDO(otherStub, "/admin/pointer-keys", "GET");
    if (!res.ok) {
      // Fail GC rather than under-count the union — under-counting risks
      // deleting blobs another project needs (data corruption).
      return {
        status: 502,
        body: {
          ok: false,
          error: {
            code: "PEER_POINTER_KEYS_FETCH_FAILED",
            message: `Failed to read pointer keys for project ${otherId}`,
          },
        },
      };
    }
    const { keys: peerKeys } = (await res.json()) as { keys: string[] };
    for (const key of peerKeys) {
      liveKeyUnion.add(key);
    }
  }

  if (!r2GcSkipped) {
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
      return {
        status: 502,
        body: {
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
      };
    }
    destroyOk = true;
  } catch {
    // Connection severed after abort() — treat as a durable wipe.
    // The authoritative check is the store-counts read-back below.
    destroyOk = true;
  }

  // ── Step 5: Probe store-counts on reconstructed DO ──────────────────────
  // doWiped is NEVER hardcoded — it is derived from the read-back.
  let doWiped = false;
  if (destroyOk) {
    try {
      const countsRes = await forwardToDO(stub, "/admin/store-counts", "GET");
      if (countsRes.ok) {
        const { counts } = (await countsRes.json()) as {
          counts: { domain: Record<string, number>; schemaHistory: number };
        };
        const domainValues = Object.values(counts.domain ?? {});
        doWiped = domainValues.length > 0 && domainValues.every((v) => v === 0);
      }
    } catch {
      // store-counts probe failed — doWiped stays false
    }
  }

  return {
    status: 200,
    body: {
      ok: true,
      doWiped,
      journalDeleted,
      r2Deleted,
      r2Kept,
      r2Failed,
      r2GcSkipped,
    },
  };
}
