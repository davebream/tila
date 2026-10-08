import {
  ArtifactVersionError,
  artifactLifecycleOps as lifecycle,
} from "@tila/ops-sqlite";
import {
  type ArtifactCommitRecord,
  ArtifactDeleteOptionsSchema,
  ArtifactDestroyRequestSchema,
  ArtifactLifecycleRecordSchema,
  artifactLifecycleKey,
} from "@tila/schemas";
import { Hono } from "hono";
import { scheduleArtifactPublication } from "./artifact-alarm";
import { originFromBody } from "./origin";
import type { RouterDeps } from "./types";

export function lifecycleStore(deps: RouterDeps): lifecycle.LifecycleStore {
  return {
    async writeRecord(key, record) {
      if (!deps.artifacts) throw new Error("Artifact bucket unavailable");
      const written = await deps.artifacts.put(key, JSON.stringify(record), {
        onlyIf: { etagDoesNotMatch: "*" },
        httpMetadata: { contentType: "application/json" },
      });
      if (!written) {
        const existing = await deps.artifacts.get(key);
        if (
          !existing ||
          JSON.stringify(
            ArtifactLifecycleRecordSchema.parse(await existing.json()),
          ) !== JSON.stringify(record)
        )
          throw new Error("Conflicting artifact lifecycle record");
      }
    },
    async deleteBlob(key) {
      if (!deps.artifacts) throw new Error("Artifact bucket unavailable");
      await deps.artifacts.delete(key);
    },
  };
}

export async function drainArtifactLifecycle(deps: RouterDeps, limit = 50) {
  if (!deps.artifacts) return { deleted: 0, errors: 0, pending: false };
  // Arm before accepting any cleanup work, including backfill.
  await scheduleArtifactPublication(deps);
  const result = await lifecycle.drainLifecycle(
    deps.db,
    lifecycleStore(deps),
    limit,
  );
  return result;
}

export async function recoverArtifactLifecycle(
  deps: RouterDeps,
  record: ArtifactCommitRecord,
) {
  if (!deps.artifacts) throw new Error("Artifact bucket unavailable");
  for (const type of [
    "destroy",
    "retention",
    "tombstone",
    "deleted",
  ] as const) {
    const key = artifactLifecycleKey({
      format: "tila-artifact-lifecycle-v1",
      type,
      project_id: record.project_id,
      lineage_id: record.pointer.lineage_id,
      kind: record.pointer.kind,
      resource: record.pointer.resource,
      pointer: record.pointer,
      at: 0,
    });
    const object = await deps.artifacts.get(key);
    if (!object) continue;
    const fact = ArtifactLifecycleRecordSchema.parse(await object.json());
    if (artifactLifecycleKey(fact) !== key)
      throw new ArtifactVersionError(
        422,
        "invalid-lifecycle-record",
        "Lifecycle key mismatch",
      );
    lifecycle.reconcileLifecycle(deps.db, fact, record.project_id);
  }
}

export function createArtifactLifecycleRoutes(deps: RouterDeps) {
  const app = new Hono();
  app.post("/artifact/version/delete", async (c) => {
    const body = await c.req.json();
    const options = ArtifactDeleteOptionsSchema.parse(body);
    await scheduleArtifactPublication(deps);
    const id = lifecycle.acceptDeletion(
      deps.db,
      body.key,
      options,
      originFromBody(body),
    );
    if (id)
      await lifecycle.publishLifecycleRecord(deps.db, lifecycleStore(deps), id);
    return c.json({ ok: true, cleanup_pending: true }, 202);
  });
  app.post("/artifact/version/destroy", async (c) => {
    const body = await c.req.json();
    ArtifactDestroyRequestSchema.parse(body);
    await scheduleArtifactPublication(deps);
    const { id, response } = lifecycle.destroyLineage(
      deps.db,
      body.lineage_id,
      ArtifactDeleteOptionsSchema.parse(body),
      originFromBody(body),
    );
    await lifecycle.publishLifecycleRecord(deps.db, lifecycleStore(deps), id);
    return c.json(response, 202);
  });
  return app;
}
