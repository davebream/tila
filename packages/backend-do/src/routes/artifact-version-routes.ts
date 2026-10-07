import { normalizeArtifactText } from "@tila/core";
import {
  artifactLifecycleOps,
  constraintOps,
  artifactVersionOps as versions,
} from "@tila/ops-sqlite";
import {
  ArtifactCommitRecordSchema,
  ArtifactLifecycleRecordSchema,
  artifactCommitKey,
  artifactLifecycleKey,
  artifactVersionPrefix,
} from "@tila/schemas";
import { Hono } from "hono";
import { originFromBody } from "./origin";
import type { RouterDeps } from "./types";

import { scheduleArtifactPublication } from "./artifact-alarm";
export { scheduleArtifactPublication } from "./artifact-alarm";
import {
  createArtifactLifecycleRoutes,
  recoverArtifactLifecycle,
} from "./artifact-lifecycle-routes";

async function publish(deps: RouterDeps, id: string) {
  const op = versions.getRevisionOperation(deps.db, id);
  if (!op || !["accepted", "published"].includes(op.state))
    throw new versions.ArtifactVersionError(
      409,
      "artifact-not-accepted",
      "Revision is not accepted",
    );
  if (op.state === "published")
    return versions.publishArtifactRevision(deps.db, id);
  if (!deps.artifacts) throw new Error("Artifact bucket unavailable");
  const record = versions.revisionRecord(op);
  const key = artifactCommitKey(record.pointer);
  const result = await deps.artifacts
    .put(key, JSON.stringify(record), {
      onlyIf: { etagDoesNotMatch: "*" },
      httpMetadata: { contentType: "application/json" },
    })
    .catch(() => {
      throw new versions.ArtifactVersionError(
        503,
        "artifact-storage-unavailable",
        "Commit record publication failed; retry with the same idempotency key",
        true,
      );
    });
  if (!result) {
    const existing = await deps.artifacts.get(key);
    if (
      !existing ||
      JSON.stringify(
        ArtifactCommitRecordSchema.parse(await existing.json()),
      ) !== JSON.stringify(record)
    )
      throw new Error("Conflicting artifact recovery record");
  }
  return versions.publishArtifactRevision(deps.db, id);
}

export async function flushArtifactCommits(deps: RouterDeps): Promise<void> {
  if (!deps.artifacts) return;
  for (const op of versions.listPendingArtifactCommits(deps.db))
    await publish(deps, op.id);
  if (versions.listPendingArtifactCommits(deps.db, 1).length)
    await scheduleArtifactPublication(deps);
}

export function createArtifactVersionRoutes(deps: RouterDeps) {
  const app = new Hono();
  app.route("/", createArtifactLifecycleRoutes(deps));
  app.get("/artifact/meta", (c) =>
    c.json({
      ok: true,
      pointer: versions.getArtifactMeta(deps.db, c.req.query("key") ?? ""),
    }),
  );
  app.get("/artifact/history", (c) =>
    c.json(
      versions.listArtifactHistory(deps.db, c.req.query("key") ?? "", {
        limit:
          c.req.query("limit") === undefined
            ? undefined
            : Number(c.req.query("limit")),
        cursor: c.req.query("cursor"),
      }),
    ),
  );
  app.post("/artifact/version/reserve", async (c) => {
    const body = await c.req.json();
    const parsed = constraintOps.resolveCurrentSchema(deps.db);
    if (parsed) {
      const check = constraintOps.checkArtifactKindDeclared(parsed, body.kind);
      if (!check.ok)
        throw new versions.ArtifactVersionError(422, check.code, check.message);
      if (
        !constraintOps.checkArtifactKindSearchable(parsed, body.kind).searchable
      )
        body.search_text = null;
    } else body.search_text = null;
    const result = versions.reserveArtifactRevision(
      deps.db,
      body,
      originFromBody(body),
    );
    return c.json({ ok: true, ...result });
  });
  app.post("/artifact/version/abort", async (c) => {
    versions.abortArtifactRevision(deps.db, (await c.req.json()).operation_id);
    return c.json({ ok: true });
  });
  app.post("/artifact/version/commit", async (c) => {
    const { operation_id: id } = await c.req.json();
    const op = versions.getRevisionOperation(deps.db, id);
    if (!op)
      throw new versions.ArtifactVersionError(
        404,
        "not-found",
        "Unknown revision operation",
      );
    if (op.state === "reserved") {
      const p = versions.revisionRecord(op).pointer;
      const blob = await deps.artifacts?.head(p.r2_key);
      if (
        !blob ||
        blob.size !== p.bytes ||
        blob.customMetadata?.["tila-sha256"] !== p.sha256
      )
        throw new versions.ArtifactVersionError(
          410,
          "artifact-unavailable",
          "Revision blob is missing or invalid",
        );
      // Schedule before accepting: a crash immediately after acceptance still
      // leaves a durable wake-up. Reindex shares this alarm slot.
      await scheduleArtifactPublication(deps);
      versions.acceptArtifactRevision(deps.db, id);
    }
    return c.json(await publish(deps, id));
  });
  app.post("/artifact/version/reconcile", async (c) => {
    const { project_id, apply = false, keys } = await c.req.json();
    if (!deps.artifacts) throw new Error("Artifact bucket unavailable");
    if (!Array.isArray(keys) || keys.length > 1000)
      throw new versions.ArtifactVersionError(
        400,
        "validation-error",
        "Expected at most 1000 commit keys",
      );
    let recovered = 0;
    for (const key of keys) {
      if (
        typeof key !== "string" ||
        !key.startsWith(artifactVersionPrefix(project_id)) ||
        (!key.endsWith(".commit.json") && !key.endsWith("/destroy.json"))
      )
        throw new versions.ArtifactVersionError(
          422,
          "invalid-commit-record",
          "Invalid commit key",
        );
      const blob = await deps.artifacts.get(key);
      if (!blob) continue;
      if (key.endsWith("/destroy.json")) {
        const record = ArtifactLifecycleRecordSchema.parse(await blob.json());
        if (
          record.type !== "destroy" ||
          artifactLifecycleKey(record) !== key ||
          record.project_id !== project_id
        )
          throw new versions.ArtifactVersionError(
            422,
            "invalid-lifecycle-record",
            "Invalid lineage retirement key",
          );
        if (apply) {
          await scheduleArtifactPublication(deps);
          artifactLifecycleOps.reconcileLifecycle(deps.db, record, project_id);
        }
        continue;
      }
      const record = ArtifactCommitRecordSchema.parse(await blob.json());
      if (
        artifactCommitKey(record.pointer) !== key ||
        record.project_id !== project_id
      )
        throw new Error("Invalid artifact commit key");
      if (apply) {
        await scheduleArtifactPublication(deps);
        await recoverArtifactLifecycle(deps, record);
        const parsedSchema = constraintOps.resolveCurrentSchema(deps.db);
        let searchText = null;
        if (
          parsedSchema &&
          constraintOps.checkArtifactKindSearchable(
            parsedSchema,
            record.pointer.kind,
          ).searchable
        ) {
          const content = await deps.artifacts.get(record.pointer.r2_key);
          if (content)
            searchText = normalizeArtifactText(
              await content.arrayBuffer(),
              record.pointer.mime_type,
            );
        }
        versions.reconcileArtifactCommit(
          deps.db,
          record,
          project_id,
          searchText ? JSON.stringify(searchText) : null,
        );
      }
      recovered++;
    }
    return c.json({ ok: true, recovered });
  });
  return app;
}
