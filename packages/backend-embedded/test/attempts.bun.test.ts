import { expect, test } from "bun:test";
import { attemptOps, schema } from "@tila/ops-sqlite";
import {
  authority,
  attemptOrigin as origin,
  seedAttempt,
} from "../../ops-sqlite/test/attempt-fixture";
import { makeHarness } from "./harness.bun";

test("Bun retains uncertain reservations and recomputes authority on acceptance replay", () => {
  const harness = makeHarness();
  try {
    const now = Date.now();
    const attempt = seedAttempt(harness.db, "task", now);
    const command = authority(attempt);
    expect(
      attemptOps.accept(harness.db, attempt.id, command, origin, now)
        .grant_valid,
    ).toBe(true);
    const expired = attemptOps.accept(
      harness.db,
      attempt.id,
      command,
      origin,
      now + 60_000,
    );
    expect(expired.attempt.state).toBe("uncertain");
    expect(expired.grant_valid).toBe(false);
    expect(
      harness.db.select().from(schema.executionReservations).all(),
    ).toHaveLength(1);
    expect(
      harness.db.select().from(schema.queueOperationReceipts).all(),
    ).toHaveLength(1);
  } finally {
    harness.close();
  }
});
