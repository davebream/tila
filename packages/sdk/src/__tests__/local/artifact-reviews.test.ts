import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { exportProjectBackup, importProjectBackup } from "../../backup";
import { buildLocalResources, createTilaLocal } from "../../local";

const roots: string[] = [];
function options() {
  const root = mkdtempSync(join(tmpdir(), "tila-artifact-reviews-"));
  roots.push(root);
  return {
    dbPath: join(root, "db.sqlite"),
    artifactsPath: join(root, "artifacts"),
    project: "reviews",
    org: "org",
    skipFilesystemCheck: true,
    identity: {
      principal_id: "local:producer",
      participant_id: "node-session",
      environment: { client_name: "node", client_version: "test" },
    },
  };
}
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

it("preserves provenance and review history across Node connections and full project export/import", async () => {
  const opts = options();
  let local = await createTilaLocal(opts);
  let facade = buildLocalResources(local.project, local.artifacts);
  const uploaded = await facade.artifacts.writeText("Evidence", {
    kind: "report",
    mimeType: "text/plain",
  });
  expect(uploaded.pointer?.provenance?.principal_id).toBe("local:producer");
  const request = {
    decision: "trusted" as const,
    expected_review_revision: 0,
    reason: "Checked source",
    idempotencyKey: "review-once",
  };
  const reviewed = await facade.artifacts.review(uploaded.key, request);
  expect(await facade.artifacts.review(uploaded.key, request)).toEqual(
    reviewed,
  );
  const before = await facade.artifacts.meta(uploaded.key);
  expect(
    (await facade.artifacts.readText(uploaded.key)).pointer?.review?.state,
  ).toBe("trusted");
  local.close();
  local = await createTilaLocal(opts);
  facade = buildLocalResources(local.project, local.artifacts);
  expect(await facade.artifacts.meta(uploaded.key)).toEqual(before);
  local.close();
  const archive = join(roots[0], "project.tila-backup");
  await exportProjectBackup({
    source: {
      backend: "local",
      projectId: opts.project,
      dbPath: opts.dbPath,
      artifactsPath: opts.artifactsPath,
    },
    output: archive,
  });
  const destination = options();
  await importProjectBackup({
    archive,
    destination: {
      backend: "local",
      projectId: destination.project,
      dbPath: destination.dbPath,
      artifactsPath: destination.artifactsPath,
    },
  });
  const restored = await createTilaLocal(destination);
  try {
    const target = buildLocalResources(restored.project, restored.artifacts);
    expect(await target.artifacts.meta(uploaded.key)).toEqual(before);
    expect((await target.artifacts.reviews(uploaded.key)).items).toHaveLength(
      1,
    );
    await target.artifacts.review(uploaded.key, {
      decision: "revoked",
      expected_review_revision: 1,
    });
    expect(
      (await target.artifacts.meta(uploaded.key)).pointer.review?.state,
    ).toBe("unreviewed");
  } finally {
    restored.close();
  }
});
