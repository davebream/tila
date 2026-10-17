import { createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { insertLegacyDigestRows } from "../../ops-sqlite/test/fixtures/legacy-digest-rows";
import {
  checkpointTime,
  createProjectCheckpoint,
  exportProjectBackup,
  importProjectBackup,
  inspectProjectBackup,
  listProjectCheckpoints,
  planProjectRecovery,
  restoreProjectCheckpoint,
} from "../../sdk/src/backup";
import {
  type RouterDeps,
  createProjectRouter,
} from "../../worker/src/do/project-do-router";
import { createBackupRoutes } from "../../worker/src/routes/backup";
import type { Env, HonoVariables } from "../../worker/src/types";
import { createCredentialFixture } from "../../worker/test/d1/helpers/credential-fixture";
import { createTestDb } from "../../worker/test/do/helpers/create-test-db";

const source = {
  backend: "cloud" as const,
  projectId: "p",
  baseUrl: "https://recovery.test",
  infraToken: "owner",
};
const blob = Buffer.from("checkpoint artifact\n");
const sha = createHash("sha256").update(blob).digest("hex");
const key = `produced/legacy-task/${sha}.txt`;
let root: string;
let db: ReturnType<typeof createTestDb>;
let d1: ReturnType<typeof createCredentialFixture>;
let objects: Map<string, Buffer>;
let failPath: string | undefined;
let loseResponse: string | undefined;
let calls: string[];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "tila-checkpoints-"));
  db = createTestDb({ foreignKeys: "on" });
  d1 = createCredentialFixture();
  objects = new Map([[key, blob]]);
  calls = [];
  failPath = undefined;
  loseResponse = undefined;
  insertLegacyDigestRows(db.sqlite, [
    "agents",
    "entities",
    "records",
    "_schema_history",
    "fences",
  ]);
  db.sqlite
    .prepare(
      "INSERT INTO artifact_pointers (r2_key, resource, kind, sha256, bytes, mime_type, produced_at, produced_by) VALUES (?, 'legacy-task', 'report', ?, ?, 'text/plain', 1, 'fixture')",
    )
    .run(key, sha, blob.length);
  d1.sqlite.exec(
    "UPDATE _projects SET display_name = 'Checkpoint name', schema_version = 1 WHERE project_id = 'p'",
  );
  const sql = {
    exec(statement: string, ...bindings: unknown[]) {
      const query = db.sqlite.prepare(statement);
      const rows = query.reader ? query.all(...bindings) : [];
      if (!query.reader) query.run(...bindings);
      return { toArray: () => rows };
    },
  };
  const doApp = createProjectRouter({
    db: db.db as RouterDeps["db"],
    ctx: {
      storage: {
        sql,
        transactionSync: (fn: () => unknown) => db.sqlite.transaction(fn)(),
      },
    } as unknown as DurableObjectState,
    enrichOpts: () => ({}),
  } as RouterDeps);
  const bucket = {
    head: async (key: string) =>
      objects.has(key)
        ? {
            size: objects.get(key)?.length,
            etag: sha,
            httpMetadata: {},
            customMetadata: {},
          }
        : null,
    get: async (key: string) =>
      objects.has(key)
        ? {
            body: new Response(new Uint8Array(objects.get(key) ?? [])).body,
            httpEtag: sha,
            customMetadata: {},
            writeHttpMetadata: () => {},
          }
        : null,
    put: async (
      key: string,
      body: ReadableStream,
      options: { sha256: ArrayBuffer },
    ) => {
      const bytes = Buffer.from(await new Response(body).arrayBuffer());
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(
        Buffer.from(options.sha256).toString("hex"),
      );
      objects.set(key, bytes);
    },
    list: async ({ prefix }: { prefix: string }) => ({
      objects: [...objects]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, bytes]) => ({
          key,
          size: bytes.length,
          etag: sha,
          customMetadata: {},
        })),
      truncated: false,
    }),
    delete: async (keys: string[]) => {
      for (const key of keys) objects.delete(key);
    },
  };
  const app = new Hono<{ Bindings: Env; Variables: HonoVariables }>();
  app.use("*", async (c, next) => {
    c.set("projectId", "p");
    c.set("doStub", {
      fetch: (req: Request) => doApp.fetch(req),
    } as DurableObjectStub);
    await next();
  });
  app.route(
    "/_internal/admin/projects/p/backup",
    createBackupRoutes({ projectTokenAuth: false }),
  );
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    calls.push(path);
    if (
      failPath &&
      path.endsWith(failPath) &&
      (failPath !== "/object" || request.method === "PUT")
    ) {
      failPath = undefined;
      return new Response("injected", { status: 503 });
    }
    const response = await app.fetch(request, {
      DB: d1.db,
      ARTIFACTS: bucket,
    } as unknown as Env);
    if (loseResponse && path.endsWith(loseResponse)) {
      loseResponse = undefined;
      throw new Error("lost response");
    }
    return response;
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  db.sqlite.close();
  d1.sqlite.close();
  await rm(root, { recursive: true, force: true });
});

async function checkpointAndChange() {
  const checkpoint = await createProjectCheckpoint({ source, directory: root });
  db.sqlite.exec(
    'UPDATE entities SET data = \'{"name":"Damaged"}\'; UPDATE records SET value_json = \'{"region":"us"}\'; UPDATE fences SET current_fence = 100',
  );
  d1.sqlite.exec(
    "UPDATE _projects SET display_name = 'Current name', membership_mode = 'hybrid', archived = 1 WHERE project_id = 'p'",
  );
  const plan = await planProjectRecovery({
    source,
    directory: root,
    to: checkpoint.checkpoint.snapshot_at,
  });
  return { checkpoint, plan };
}

function assertRecovered() {
  expect(db.sqlite.prepare("SELECT data FROM entities").get()).toEqual({
    data: '{"name":"Legacy task","status":"open"}',
  });
  expect(db.sqlite.prepare("SELECT value_json FROM records").get()).toEqual({
    value_json: '{"region":"eu"}',
  });
  expect(
    db.sqlite
      .prepare(
        "SELECT current_fence FROM fences WHERE resource = 'task:legacy-task'",
      )
      .get(),
  ).toEqual({ current_fence: 101 });
  expect(
    d1.sqlite
      .prepare(
        "SELECT display_name, membership_mode, archived FROM _projects WHERE project_id = 'p'",
      )
      .get(),
  ).toEqual({
    display_name: "Checkpoint name",
    membership_mode: "hybrid",
    archived: 1,
  });
  expect(
    db.sqlite.prepare("SELECT * FROM _project_transfer_state").all(),
  ).toEqual([]);
  expect(
    db.sqlite
      .prepare(
        "SELECT COUNT(*) AS n FROM journal WHERE kind = 'project.restored'",
      )
      .get(),
  ).toEqual({ n: 1 });
}

describe("complete checkpoint recovery", () => {
  it.each([false, true])(
    "reports actual archive bytes for cloud export (checkpoint: %s)",
    async (withCheckpoint) => {
      const archive = join(root, "sizes.tila-backup");
      const exported = await exportProjectBackup({
        source,
        output: archive,
        ...(withCheckpoint
          ? {
              checkpoint: {
                version: 1 as const,
                id: "8c4f3c9d-f971-483b-9d6e-52a35ad57481",
                project_id: source.projectId,
                instance: source.baseUrl,
                account_id: "cf",
              },
            }
          : {}),
      });
      const size = (await stat(archive)).size;
      const inspected = await inspectProjectBackup(archive);
      // Read the raw tar independently of SDK inspection, which normalizes
      // historical statistics. Skip entries using their actual tar header sizes.
      const bytes = await readFile(archive);
      let storedBytes: number | undefined;
      for (let offset = 0; offset + 512 <= bytes.length; ) {
        const name = bytes
          .toString("utf8", offset, offset + 100)
          .split("\0")[0];
        const length = Number.parseInt(
          bytes.toString("ascii", offset + 124, offset + 136),
          8,
        );
        if (!name) break;
        offset += 512;
        if (name === "manifest.json") {
          storedBytes = JSON.parse(
            bytes.toString("utf8", offset, offset + length),
          ).stats.archive_bytes;
          break;
        }
        offset += Math.ceil(length / 512) * 512;
      }
      expect(storedBytes).toBe(size);
      expect(exported.stats.archive_bytes).toBe(size);
      expect(inspected.manifest.stats.archive_bytes).toBe(size);
      expect(Boolean(inspected.checkpoint)).toBe(withCheckpoint);
      if (withCheckpoint) {
        expect(inspected.checkpoint?.account_id).toBe(
          exported.source.cloudflare_account_id,
        );
      }
      // A local restore covers the public import result without depending on
      // the unrelated ordinary cloud-import preflight behavior.
      const restored = await importProjectBackup({
        archive,
        destination: {
          backend: "local",
          projectId: source.projectId,
          dbPath: join(root, "restored.db"),
          artifactsPath: join(root, "restored-artifacts"),
        },
      });
      expect(restored.manifest.stats.archive_bytes).toBe(size);
      expect(restored.manifest.semantic_digest).toBe(exported.semantic_digest);
    },
  );

  it("restores project data and files, preserves current access, and verifies a durable receipt", async () => {
    const { plan } = await checkpointAndChange();
    // A deleted blob is represented as deleted in the current state, so the safety archive is complete too.
    db.sqlite
      .prepare(
        "UPDATE artifact_pointers SET tombstoned = 1, tombstoned_at = 2, blob_deleted_at = 3 WHERE r2_key = ?",
      )
      .run(key);
    objects.delete(key);
    const result = await restoreProjectCheckpoint({ source, plan });
    expect(result.actual_time).toBe(plan.checkpoint.snapshot_at);
    expect(objects.get(key)).toEqual(blob);
    assertRecovered();
    const retry = await planProjectRecovery({
      source,
      directory: root,
      resume: plan.operation_id,
    });
    await restoreProjectCheckpoint({ source, plan: retry });
    assertRecovered();
  });

  it.each([
    "/object",
    "/transfer/rows/records",
    "/d1/restore",
    "/transfer/finalize",
  ])("resumes interruption at %s", async (path) => {
    const { plan } = await checkpointAndChange();
    failPath = path;
    await expect(restoreProjectCheckpoint({ source, plan })).rejects.toThrow();
    failPath = undefined;
    loseResponse = undefined;
    const retry = await planProjectRecovery({
      source,
      directory: root,
      resume: plan.operation_id,
    });
    await restoreProjectCheckpoint({ source, plan: retry });
    assertRecovered();
  });

  it("uses the exact safety archive on rollback, resets failed chunks, and can retry rollback", async () => {
    const { plan } = await checkpointAndChange();
    failPath = "/d1/restore";
    await expect(restoreProjectCheckpoint({ source, plan })).rejects.toThrow();
    const rollback = await planProjectRecovery({
      source,
      directory: root,
      rollback: plan.operation_id,
    });
    failPath = "/transfer/rows/records";
    await expect(
      restoreProjectCheckpoint({ source, plan: rollback }),
    ).rejects.toThrow();
    await restoreProjectCheckpoint({ source, plan: rollback });
    expect(db.sqlite.prepare("SELECT data FROM entities").get()).toEqual({
      data: '{"name":"Damaged"}',
    });
    expect(
      d1.sqlite
        .prepare("SELECT display_name FROM _projects WHERE project_id = 'p'")
        .get(),
    ).toEqual({ display_name: "Current name" });
    expect(
      db.sqlite.prepare("SELECT * FROM _project_transfer_state").all(),
    ).toEqual([]);
  });

  it("recovers a lost final response without applying the snapshot twice", async () => {
    const { plan } = await checkpointAndChange();
    loseResponse = "/transfer/finalize";
    await expect(restoreProjectCheckpoint({ source, plan })).rejects.toThrow(
      "lost response",
    );
    await restoreProjectCheckpoint({ source, plan });
    assertRecovered();
  });

  it("selects verified metadata instead of filenames and refuses incomplete candidates", async () => {
    const { checkpoint, plan } = await checkpointAndChange();
    expect(await readdir(root)).toEqual([checkpoint.archive.split("/").at(-1)]);
    expect(plan.checkpoint.id).toBe(checkpoint.checkpoint.id);
    expect(checkpointTime("2026-01-01T12:00:00+02:00")).toBe(
      "2026-01-01T10:00:00.000Z",
    );
    expect(() => checkpointTime("2026-01-01T12:00:00")).toThrow("timezone");
    await writeFile(join(root, "broken.tila-backup.partial-test"), "partial");
    expect(
      (await listProjectCheckpoints({ directory: root })).some(
        (entry) => entry.error,
      ),
    ).toBe(true);
    await expect(
      planProjectRecovery({ source, directory: root, to: plan.requested_at }),
    ).rejects.toThrow("Incomplete");
    expect(await readdir(root)).not.toContain(".safety");
  });

  it("rejects modified archives before creating an operation or starting a transfer", async () => {
    const { plan } = await checkpointAndChange();
    const bytes = await readFile(plan.archive);
    bytes[1024] ^= 1;
    await writeFile(plan.archive, bytes);
    calls = [];
    await expect(restoreProjectCheckpoint({ source, plan })).rejects.toThrow();
    expect(calls.some((path) => path.endsWith("/transfer/begin"))).toBe(false);
    expect(await readdir(root)).not.toContain(".safety");
  });
  it("includes the exact timestamp boundary and breaks equal-time ties by checkpoint ID", async () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      const first = await createProjectCheckpoint({ source, directory: root });
      const second = await createProjectCheckpoint({ source, directory: root });
      const selected = await planProjectRecovery({
        source,
        directory: root,
        to: new Date(now).toISOString(),
      });
      expect(selected.checkpoint.id).toBe(
        [first.checkpoint.id, second.checkpoint.id].sort().at(-1),
      );
      await expect(
        planProjectRecovery({
          source,
          directory: root,
          to: new Date(now - 1).toISOString(),
        }),
      ).rejects.toThrow("No verified checkpoint");
    } finally {
      clock.mockRestore();
    }
  });
  it("refuses an unsupported Worker before taking a lock or writing files", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json({ migrationVersion: 43 }),
    );
    await expect(
      createProjectCheckpoint({ source, directory: root }),
    ).rejects.toThrow("upgrade the Worker");
    expect(calls).toEqual([]);
    expect(await readdir(root)).toEqual([]);
  });

  it("rejects cross-instance selection and times before the oldest checkpoint", async () => {
    const { plan } = await checkpointAndChange();
    await expect(
      planProjectRecovery({
        source: { ...source, baseUrl: "https://other.test" },
        directory: root,
        to: plan.requested_at,
      }),
    ).rejects.toThrow("different project, instance, or account");
    await expect(
      planProjectRecovery({
        source,
        directory: root,
        to: "2000-01-01T00:00:00Z",
      }),
    ).rejects.toThrow("No verified checkpoint");
  });

  it("does not resolve the timestamp again when resuming an operation", async () => {
    const { plan } = await checkpointAndChange();
    failPath = "/d1/restore";
    await expect(restoreProjectCheckpoint({ source, plan })).rejects.toThrow();
    await writeFile(
      join(root, "unrelated.tila-backup.partial-test"),
      "partial",
    );
    const resumed = await planProjectRecovery({
      source,
      directory: root,
      resume: plan.operation_id,
    });
    expect(resumed.archive_digest).toBe(plan.archive_digest);
    await restoreProjectCheckpoint({ source, plan: resumed });
    assertRecovered();
  });
  it("removes discarded journal segments so subsequent checkpoints remain valid", async () => {
    const { plan } = await checkpointAndChange();
    // Safety capture must see a coherent current journal archive.
    const archiveKey = "journal-archive/p/2026/10.part-1-from-1.jsonl";
    objects.set(
      archiveKey,
      Buffer.from(
        JSON.stringify({
          seq: 1,
          t: 1,
          kind: "entity.created",
          resource: "task:legacy-task",
          principal_id: "fixture",
          participant_id: "fixture",
          environment: {},
          data: {},
        }),
      ),
    );
    db.sqlite.exec(
      "INSERT OR REPLACE INTO _journal_archive_watermark (id, last_archived_seq, archived_at) VALUES (1, 1, 1)",
    );
    await restoreProjectCheckpoint({ source, plan });
    expect(objects.has(archiveKey)).toBe(false);
    const after = await createProjectCheckpoint({ source, directory: root });
    expect(after.checkpoint.project_id).toBe("p");
  });
});
