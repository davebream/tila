import { SELF, runInDurableObject } from "cloudflare:test";
import { projectTransferOps } from "@tila/ops-sqlite";
import { describe, expect, it } from "vitest";
import { insertLegacyDigestRows } from "../../ops-sqlite/test/fixtures/legacy-digest-rows";
import { bindings } from "./setup";

const project = "checkpoint-runtime";
const root = `/_internal/admin/projects/${project}/backup`;
async function call(path: string, body?: unknown, method?: string) {
  const response = await SELF.fetch(`https://worker${root}${path}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: {
      Authorization: "Bearer runtime-test-infra-owner",
      "Content-Type": "application/json",
      "X-Confirm-Slug": project,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  expect(response.status, await response.clone().text()).toBe(200);
  return response;
}

describe("checkpoint recovery through the real Worker and Cloudflare storage", () => {
  it("preserves current access, fences ordinary claims, rejects a different rollback, and records completion", async () => {
    await bindings.DB.prepare(
      "INSERT INTO _projects (project_id, display_name, created_at, created_by, cloudflare_account_id, schema_version) VALUES (?, 'Original', 0, 'fixture', 'local', 1)",
    )
      .bind(project)
      .run();
    const stub = bindings.PROJECT.get(bindings.PROJECT.idFromName(project));
    // Wake the production DO and apply migrations before seeding its data.
    await call("/transfer/status");
    await runInDurableObject(stub, async (_instance, state) => {
      insertLegacyDigestRows(
        {
          prepare: (query) => ({
            run: (...args) => state.storage.sql.exec(query, ...args),
          }),
        },
        ["entities", "records", "_schema_history", "fences"],
      );
    });
    expect(await (await call("/capabilities")).json()).toMatchObject({
      recovery: "preserve-current-access-v1",
      projectId: project,
      accountId: "local",
    });
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO claims (resource, principal_id, participant_id, mode, fence, acquired_at, expires_at) VALUES ('task:legacy-task', 'old-owner', 'old-process', 'exclusive', 3, 0, 9999999999999)",
      );
    });
    const exportId = crypto.randomUUID();
    const { state: exportState } = (await (
      await call("/transfer/begin", { sessionId: exportId, mode: "export" })
    ).json()) as { state: { started_at: number } };
    const meta = (await (
      await call(`/transfer/meta?sessionId=${exportId}`)
    ).json()) as {
      digest: string;
      tables: string[];
      migrationVersion: number;
      journal: { nextSequence: number };
    };
    const snapshot = new Map<string, Record<string, unknown>[]>();
    for (const table of meta.tables) {
      const page = (await (
        await call(`/transfer/snapshot/${table}?sessionId=${exportId}`)
      ).json()) as { rows: Record<string, unknown>[] };
      snapshot.set(table, page.rows);
    }
    const { sections } = (await (
      await call(`/d1?sessionId=${exportId}`)
    ).json()) as { sections: Record<string, unknown[]> };
    // DO maintenance rejects cleanup while the checkpoint is being captured.
    const cleanup = await stub.fetch("http://do/artifact/tombstone", {
      method: "POST",
      body: JSON.stringify({ r2_key: "unused" }),
    });
    expect(cleanup.status).toBe(423);
    await call("/transfer/complete-export", { sessionId: exportId });
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec("UPDATE entities SET data = '{}' ");
      state.storage.sql.exec(
        "UPDATE fences SET current_fence = 900 WHERE resource = 'task:legacy-task'",
      );
    });
    await bindings.DB.prepare(
      "UPDATE _projects SET display_name = 'Changed', membership_mode = 'explicit', archived = 1, oidc_audience = 'keep-current' WHERE project_id = ?",
    )
      .bind(project)
      .run();
    const sessionId = crypto.randomUUID();
    await call("/transfer/begin", { sessionId, mode: "export" });
    const recovery = {
      policy: "preserve-current-access",
      checkpoint: {
        version: 1,
        id: crypto.randomUUID(),
        project_id: project,
        instance: "https://worker",
        account_id: "local",
        snapshot_at: new Date(exportState.started_at).toISOString(),
      },
      requested_at: new Date().toISOString(),
      archive_digest: "a".repeat(64),
      safety_digest: "b".repeat(64),
      safety_archive: "/backups/.safety/test.tila-backup",
    };
    await call("/transfer/promote", {
      sessionId,
      mode: "import",
      archiveDigest: recovery.archive_digest,
      safetyArchive: recovery.safety_archive,
      recovery,
    });
    const wrongRollback = await SELF.fetch(
      `https://worker${root}/transfer/retarget`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer runtime-test-infra-owner",
          "X-Confirm-Slug": project,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ sessionId, archiveDigest: "c".repeat(64) }),
      },
    );
    expect(wrongRollback.status).toBe(409);
    await call("/transfer/prepare", { sessionId });
    for (const [table, rows] of snapshot) {
      if (!rows.length) continue;
      const content = `${rows.map(projectTransferOps.canonicalJson).join("\n")}\n`;
      await call(`/transfer/rows/${table}`, {
        sessionId,
        chunkIndex: 0,
        rows,
        sha256: await projectTransferOps.sha256Hex(content),
      });
    }
    await call("/d1/restore", { sessionId, sections });
    const discarded = `journal-archive/${project}/discarded.jsonl`;
    const otherProject = "journal-archive/other/retained.jsonl";
    await bindings.ARTIFACTS.put(discarded, "discarded history");
    await bindings.ARTIFACTS.put(otherProject, "other project");
    await call("/journal-archives/reconcile", { sessionId, keys: [] });
    expect(await bindings.ARTIFACTS.head(discarded)).toBeNull();
    expect(await bindings.ARTIFACTS.head(otherProject)).not.toBeNull();
    await call("/transfer/finalize", {
      sessionId,
      semanticDigest: meta.digest,
      migrationVersion: meta.migrationVersion,
      journalNextSequence: meta.journal.nextSequence,
    });
    expect(
      await bindings.DB.prepare(
        "SELECT display_name, membership_mode, archived, oidc_audience FROM _projects WHERE project_id = ?",
      )
        .bind(project)
        .first(),
    ).toEqual({
      display_name: "Original",
      membership_mode: "explicit",
      archived: 1,
      oidc_audience: "keep-current",
    });
    expect(await (await call(`/recovery/${sessionId}`)).json()).toMatchObject({
      receipt: {
        operation_id: sessionId,
        archive_digest: recovery.archive_digest,
        mode: "import",
      },
    });
    await runInDurableObject(stub, async (_instance, state) => {
      expect(
        state.storage.sql
          .exec(
            "SELECT current_fence FROM fences WHERE resource = 'task:legacy-task'",
          )
          .toArray(),
      ).toEqual([{ current_fence: 901 }]);
      expect(
        state.storage.sql.exec("SELECT value_json FROM records").toArray(),
      ).toEqual([{ value_json: '{"region":"eu"}' }]);
      expect(
        state.storage.sql.exec("SELECT kind FROM journal").toArray(),
      ).toEqual([{ kind: "project.restored" }]);
      expect(state.storage.sql.exec("SELECT * FROM claims").toArray()).toEqual(
        [],
      );
      expect(projectTransferOps.getTransferState(state.storage.sql)).toBeNull();
    });
  });
});
