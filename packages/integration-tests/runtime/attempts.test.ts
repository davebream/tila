import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { attemptOps, schema } from "@tila/ops-sqlite";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { expect, it } from "vitest";
import {
  authority,
  attemptOrigin as origin,
  seedAttempt,
} from "../../ops-sqlite/test/attempt-fixture";
import { bindings } from "./setup";

it("persists execution receipts and capacity through a real DO cold start and lease expiry", async () => {
  const stub = bindings.PROJECT.get(bindings.PROJECT.newUniqueId());
  const now = Date.now();
  const reserved = await runInDurableObject(stub, (_instance, state) => {
    const db = drizzle(state.storage, { schema });
    const attempt = seedAttempt(db, "task", now);
    attemptOps.accept(
      db,
      attempt.id,
      authority(attempt, "accept"),
      origin,
      now,
    );
    return attempt;
  });
  await evictDurableObject(stub);
  await runInDurableObject(stub, (_instance, state) => {
    const db = drizzle(state.storage, { schema });
    const replay = attemptOps.accept(
      db,
      reserved.id,
      authority(reserved, "accept"),
      origin,
      now + 60_000,
    );
    expect(replay.grant_valid).toBe(false);
    expect(replay.attempt.state).toBe("uncertain");
    expect(db.select().from(schema.executionReservations).all()).toHaveLength(
      1,
    );
    expect(db.select().from(schema.queueOperationReceipts).all()).toHaveLength(
      1,
    );
  });
});

it("rolls back an admission failure including claim, fence and journal on DO SQLite", async () => {
  const stub = bindings.PROJECT.get(bindings.PROJECT.newUniqueId());
  await runInDurableObject(stub, (_instance, state) => {
    const db = drizzle(state.storage, { schema });
    seedAttempt(db);
    const before = db.select().from(schema.journal).all();
    const entry = db.select().from(schema.queueEntries).get();
    if (!entry) throw new Error("entry");
    expect(() =>
      db.transaction((tx) => {
        tx.delete(schema.executionReservations).run();
        tx.delete(schema.claims).run();
        attemptOps.reserveInTransaction(tx, entry, origin, 60_000);
      }),
    ).toThrow();
    expect(db.select().from(schema.executionReservations).all()).toHaveLength(
      1,
    );
    expect(db.select().from(schema.journal).all()).toEqual(before);
  });
});
