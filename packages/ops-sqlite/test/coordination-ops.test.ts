import { formatRecordResource } from "@tila/schemas";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  acquire,
  heartbeat,
  listAllPresence,
  listClaims,
  release,
  renew,
  state,
} from "../src/coordination-ops";
import { FenceNotFoundError } from "../src/fence-ops";
import { createRecord, setRecord } from "../src/record-ops";
import { type TestDb, createEntity, createTestDb } from "./helpers";

let testDb: TestDb;

beforeEach(() => {
  testDb = createTestDb();
});

afterEach(() => {
  testDb.rawDb.close();
});

describe("coordination ops regressions", () => {
  it("returns the live claim from state() when the caller uses a bare entity id", () => {
    createEntity(testDb.db, { id: "abc-123", type: "task" });

    const claim = acquire(
      testDb.db,
      "abc-123",
      "agent-a",
      "agent-a",
      "exclusive",
      60_000,
    );

    expect(claim.acquired).toBe(true);
    expect(state(testDb.db, "abc-123")?.resource).toBe("task:abc-123");
  });

  it("releases a bare-id entity claim instead of leaving it in listClaims()", () => {
    createEntity(testDb.db, { id: "abc-123", type: "task" });

    const claim = acquire(
      testDb.db,
      "abc-123",
      "agent-a",
      "agent-a",
      "exclusive",
      60_000,
    );

    release(testDb.db, "abc-123", claim.fence, { actor: "agent-a/agent-a" });

    expect(listClaims(testDb.db)).toEqual([]);
  });

  it("renews a bare-id entity claim against the canonical stored row", () => {
    createEntity(testDb.db, { id: "abc-123", type: "task" });

    const claim = acquire(
      testDb.db,
      "abc-123",
      "agent-a",
      "agent-a",
      "exclusive",
      60_000,
    );

    expect(
      renew(testDb.db, "abc-123", "agent-a", "agent-a", claim.fence, 120_000),
    ).toMatchObject({ renewed: true });
  });

  it("fails closed when a record update carries a fence but no fence row exists", async () => {
    const created = await createRecord(
      testDb.db,
      {
        type: "config",
        key: "main",
        value: { version: 1 },
        schema_version: 1,
        actor: "test-agent",
      },
      { actor: "test-agent" },
    );

    expect(created.fence).toBeGreaterThan(0);

    const resource = formatRecordResource("config", "main");
    testDb.rawDb.prepare("DELETE FROM fences WHERE resource = ?").run(resource);

    await expect(
      setRecord(
        testDb.db,
        {
          type: "config",
          key: "main",
          value: { version: 2 },
          fence: created.fence,
          schema_version: 1,
          actor: "test-agent",
        },
        { actor: "test-agent" },
      ),
    ).rejects.toThrow(FenceNotFoundError);
  });

  it("preserves the current fence on self-reacquire", () => {
    const first = acquire(
      testDb.db,
      "task:abc-123",
      "agent-a",
      "agent-a",
      "exclusive",
      60_000,
    );

    const second = acquire(
      testDb.db,
      "task:abc-123",
      "agent-a",
      "agent-a",
      "exclusive",
      60_000,
    );

    expect(second).toMatchObject({
      acquired: true,
      fence: first.fence,
    });
  });

  it("rejects release by a non-owner and keeps the claim present", () => {
    const claim = acquire(
      testDb.db,
      "task:abc-123",
      "agent-a",
      "agent-a",
      "exclusive",
      60_000,
    );

    expect(() =>
      release(testDb.db, "task:abc-123", claim.fence, {
        actor: "agent-b/agent-b",
      }),
    ).toThrow();
    expect(listClaims(testDb.db)).toHaveLength(1);
  });

  it("release of an absent (already-released) claim is a no-op and emits no journal", () => {
    const claim = acquire(
      testDb.db,
      "task:abc-123",
      "agent-a",
      "agent-a",
      "exclusive",
      60_000,
    );
    // The owner releases: claim deleted, one claim.released journal row.
    release(testDb.db, "task:abc-123", claim.fence, {
      actor: "agent-a/agent-a",
    });

    const countReleased = () =>
      (
        testDb.rawDb
          .prepare("SELECT COUNT(*) AS c FROM journal WHERE kind = ?")
          .get("claim.released") as { c: number }
      ).c;
    expect(countReleased()).toBe(1);

    // A second release -- now by a different actor, with the claim already
    // gone -- must be an idempotent no-op: no throw and, crucially, no extra
    // claim.released journal row attributed to a non-holder.
    expect(() =>
      release(testDb.db, "task:abc-123", claim.fence, {
        actor: "agent-b/agent-b",
      }),
    ).not.toThrow();
    expect(countReleased()).toBe(1);
  });

  it("still renews successfully after self-reacquire reuses the same fence", () => {
    const claim = acquire(
      testDb.db,
      "task:abc-123",
      "agent-a",
      "agent-a",
      "exclusive",
      60_000,
    );

    const reacquired = acquire(
      testDb.db,
      "task:abc-123",
      "agent-a",
      "agent-a",
      "exclusive",
      60_000,
    );

    expect(
      renew(
        testDb.db,
        "task:abc-123",
        "agent-a",
        "agent-a",
        reacquired.fence,
        120_000,
      ),
    ).toMatchObject({ renewed: true });
    expect(reacquired.fence).toBe(claim.fence);
  });

  it("keeps exact-match state() behavior for non-entity resources", () => {
    const resource = formatRecordResource("config", "main");

    const claim = acquire(
      testDb.db,
      resource,
      "agent-a",
      "agent-a",
      "exclusive",
      60_000,
    );

    expect(claim.acquired).toBe(true);
    expect(state(testDb.db, resource)?.resource).toBe(resource);
  });

  it.todo(
    "covers embedded-layer release ownership via EmbeddedProject once the holder check is enforced",
  );
});

describe("listAllPresence", () => {
  it("returns ALL presence rows including stale ones, with active:false for stale", () => {
    const now = Date.now();
    const ttlMs = 60_000;
    // Fresh machine: last_seen = now (active)
    heartbeat(testDb.db, "machine-fresh", { role: "worker" }, now);
    // Stale machine: last_seen far in the past (inactive)
    heartbeat(testDb.db, "machine-stale", { role: "old" }, now - ttlMs - 1000);

    const rows = listAllPresence(testDb.db, ttlMs, now);

    expect(rows).toHaveLength(2);

    const fresh = rows.find((r) => r.machine === "machine-fresh");
    const stale = rows.find((r) => r.machine === "machine-stale");

    expect(fresh).toBeDefined();
    expect(fresh?.active).toBe(true);

    expect(stale).toBeDefined();
    expect(stale?.active).toBe(false);
  });
});
