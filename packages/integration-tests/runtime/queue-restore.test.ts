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
