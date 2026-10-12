import { runInDurableObject } from "cloudflare:test";
import {
  attemptOps,
  projectTransferOps,
  queueBackupOps,
  queueOps,
  schema,
} from "@tila/ops-sqlite";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { expect, it } from "vitest";
import {
  authority,
  attemptOrigin as origin,
  seedAttempt,
} from "../../ops-sqlite/test/attempt-fixture";
import { post } from "./helpers";
import { bindings } from "./setup";

it("restores queue state through the real DO transfer protocol with destination fence watermarks", async () => {
  const stub = bindings.PROJECT.get(bindings.PROJECT.newUniqueId());
  const accepted = await runInDurableObject(stub, async (_instance, state) => {
    const db = drizzle(state.storage, { schema });
    const attempt = seedAttempt(db);
    queueOps.configure(
      db,
      {
        idempotency_key: "enable",
        expected_revision: 0,
        enabled: true,
        paused: false,
        execution_limit: 1,
      },
      origin,
      true,
    );
    return attemptOps.accept(
      db,
      attempt.id,
      authority(attempt, "accept"),
      origin,
    ).attempt;
  });
  const meta = await (
    await stub.fetch("https://project/admin/transfer/meta")
  ).json<{
    digest: string;
    migrationVersion: number;
    journal: { nextSequence: number };
    tables: string[];
  }>();
  const snapshot = new Map<string, Record<string, unknown>[]>();
  for (const table of meta.tables) {
    const result = await (
      await stub.fetch(
        `https://project/admin/transfer/snapshot/${table}?limit=500`,
      )
    ).json<{ rows: Record<string, unknown>[] }>();
    snapshot.set(table, result.rows);
  }
  const rejected = await post(stub, "/admin/transfer/begin", {
    sessionId: "unsafe-restore",
    mode: "import",
    owner: "fixture",
    archiveDigest: "fixture",
  });
  expect(rejected.status).toBe(409);
  await runInDurableObject(stub, async (_instance, state) => {
    const db = drizzle(state.storage, { schema });
    expect(attemptOps.get(db, accepted.id)).toEqual(accepted);
    expect(projectTransferOps.getTransferState(state.storage.sql)).toBeNull();
  });
  expect(
    (
      await post(stub, "/admin/transfer/begin", {
        sessionId: "safety-export",
        mode: "export",
        owner: "fixture",
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await post(stub, "/admin/transfer/promote", {
        sessionId: "safety-export",
        mode: "import",
        archiveDigest: "fixture",
      })
    ).status,
  ).toBe(409);
  await runInDurableObject(stub, async (_instance, state) => {
    expect(projectTransferOps.getTransferState(state.storage.sql)).toBeNull();
  });
  const destinationFence = await runInDurableObject(
    stub,
    async (_instance, state) => {
      const db = drizzle(state.storage, { schema });
      for (let index = 0; index < 3; index++)
        db.transaction((tx) =>
          attemptOps.refence(
            tx,
            attemptOps.get(tx, accepted.id),
            origin,
            Date.now(),
          ),
        );
      const current = attemptOps.get(db, accepted.id);
      attemptOps.finish(
        db,
        current.id,
        {
          ...authority(current),
          outcome: {
            status: "success",
            execution_stopped: true,
            unresolved_external_execution: false,
            evidence: [],
          },
        },
        origin,
      );
      return queueBackupOps.readFenceWatermarks(db)[accepted.resource];
    },
  );
  const sessionId = crypto.randomUUID();
  const send = async (path: string, body: Record<string, unknown>) => {
    const response = await post(stub, path, body);
    expect(response.status, await response.clone().text()).toBe(200);
    return response;
  };
  await send("/admin/transfer/begin", {
    sessionId,
    mode: "import",
    owner: "fixture",
    archiveDigest: "fixture",
  });
  await send("/admin/transfer/prepare", { sessionId });
  await send("/admin/transfer/prepare", { sessionId });
  for (const [table, rows] of snapshot) {
    const encoded =
      rows.map((row) => projectTransferOps.canonicalJson(row)).join("\n") +
      (rows.length ? "\n" : "");
    await send(`/admin/transfer/rows/${table}`, {
      sessionId,
      chunkIndex: 0,
      sha256: await projectTransferOps.sha256Hex(encoded),
      rows,
    });
  }
  await send("/admin/transfer/finalize", {
    sessionId,
    semanticDigest: meta.digest,
    migrationVersion: meta.migrationVersion,
    journalNextSequence: meta.journal.nextSequence,
  });
  await runInDurableObject(stub, async (_instance, state) => {
    const db = drizzle(state.storage, { schema });
    expect(queueOps.policy(db).paused).toBe(true);
    expect(attemptOps.view(db, accepted.id, origin)).toMatchObject({
      grant_valid: false,
      attempt: { state: "uncertain" },
    });
    expect(
      queueBackupOps.readFenceWatermarks(db)[accepted.resource],
    ).toBeGreaterThan(destinationFence);
    expect(queueOps.occupancy(db)).toEqual({ execution: 1, wip: 1 });
  });
});

it("restores a prequeue snapshot with dispatch disabled and ordinary work preserved", async () => {
  const stub = bindings.PROJECT.get(bindings.PROJECT.newUniqueId());
  expect(
    (
      await post(stub, "/entity/create", {
        id: "legacy",
        type: "task",
        data: { status: "open" },
        created_by: "fixture",
      })
    ).status,
  ).toBe(200);
  const old = await runInDurableObject(stub, async (_instance, state) => ({
    digest: await projectTransferOps.semanticDigest(state.storage.sql, 31),
    journal: projectTransferOps.journalState(state.storage.sql),
    sections: projectTransferOps.PROJECT_BACKUP_TABLES.filter(
      (table) =>
        ![
          "queue_policy",
          "queue_entries",
          "work_attempts",
          "execution_reservations",
          "queue_operation_receipts",
        ].includes(table),
    ).map((table) => ({
      table,
      rows: projectTransferOps.readSnapshotPage(state.storage.sql, table, {
        limit: 1000,
      }).rows,
    })),
  }));
  const sessionId = "legacy-restore";
  expect(
    (
      await post(stub, "/admin/transfer/begin", {
        sessionId,
        mode: "import",
        owner: "fixture",
        archiveDigest: "legacy",
      })
    ).status,
  ).toBe(200);
  expect(
    (await post(stub, "/admin/transfer/prepare", { sessionId })).status,
  ).toBe(200);
  for (const { table, rows } of old.sections) {
    const encoded =
      rows.map((row) => projectTransferOps.canonicalJson(row)).join("\n") +
      (rows.length ? "\n" : "");
    expect(
      (
        await post(stub, `/admin/transfer/rows/${table}`, {
          sessionId,
          chunkIndex: 0,
          rows,
          sha256: await projectTransferOps.sha256Hex(encoded),
        })
      ).status,
    ).toBe(200);
  }
  const restored = await post(stub, "/admin/transfer/finalize", {
    sessionId,
    semanticDigest: old.digest,
    migrationVersion: 31,
    journalNextSequence: old.journal.nextSequence,
  });
  expect(restored.status, await restored.clone().text()).toBe(200);
  await runInDurableObject(stub, async (_instance, state) => {
    const db = drizzle(state.storage, { schema });
    expect(queueOps.policy(db)).toMatchObject({ enabled: false, paused: true });
    expect(db.select().from(schema.entities).all()).toMatchObject([
      { id: "legacy", data: '{"status":"open"}' },
    ]);
  });
});
