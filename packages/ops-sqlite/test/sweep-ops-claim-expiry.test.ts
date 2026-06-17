/**
 * Tests for B3 — the claim sweep journals `claim.expired` (audit-trail
 * completeness).
 *
 * Before B3 the sweep bulk-DELETEd expired claims with no journal entry, so
 * lease expiry — the most important coordination transition — left no audit
 * trace, and a consumer could not distinguish "released" from "expired-and-
 * swept". B3 restructures the claim sweep to SELECT the expired claims, append
 * one `claim.expired` journal row per claim, then delete — ALL in the same
 * transaction as the delete, so the journal row and the delete commit (or roll
 * back) atomically.
 */
import { lte } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as journalOps from "../src/journal-ops";
import * as schema from "../src/schema";
import { sweep } from "../src/sweep-ops";
import { type TestDb, createTestDb } from "./helpers";

let testDb: TestDb;

beforeEach(() => {
  testDb = createTestDb();
});

afterEach(() => {
  testDb.rawDb.close();
});

/** Insert a claim row directly so we control expires_at / holder / fence. */
function insertClaim(
  db: TestDb,
  args: {
    resource: string;
    machine: string;
    user: string;
    mode?: string;
    fence?: number;
    expiresAt: number;
  },
): void {
  db.rawDb
    .prepare(
      `INSERT INTO claims(resource, holder, machine, user, mode, fence, acquired_at, expires_at, metadata)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, '{}')`,
    )
    .run(
      args.resource,
      `${args.machine}/${args.user}`,
      args.machine,
      args.user,
      args.mode ?? "exclusive",
      args.fence ?? 1,
      args.expiresAt - 1000,
      args.expiresAt,
    );
}

function journalRows(db: TestDb): Array<{
  kind: string;
  resource: string;
  actor: string;
  fence: number | null;
  data: Record<string, unknown>;
}> {
  return journalOps.listJournal(db.db, { limit: 1000 }).map((r) => ({
    kind: r.kind,
    resource: r.resource,
    actor: r.actor,
    fence: r.fence,
    data: r.data,
  }));
}

describe("sweep — claim.expired journaling", () => {
  it("appends exactly one claim.expired row per swept (expired) claim", () => {
    const now = Date.now();
    insertClaim(testDb, {
      resource: "task:abc",
      machine: "m1",
      user: "u1",
      fence: 7,
      expiresAt: now - 5000, // expired
    });

    const result = sweep(testDb.db, now);

    expect(result.claimsDeleted).toBe(1);
    const expiredRows = journalRows(testDb).filter(
      (r) => r.kind === "claim.expired",
    );
    expect(expiredRows).toHaveLength(1);
    expect(expiredRows[0].resource).toBe("task:abc");
    // Holder identity is preserved so the audit trail names whose lease lapsed.
    expect(expiredRows[0].actor).toBe("m1/u1");
    // The claim's fence is recorded.
    expect(expiredRows[0].fence).toBe(7);
  });

  it("does NOT journal claims that are still live", () => {
    const now = Date.now();
    insertClaim(testDb, {
      resource: "task:live",
      machine: "m1",
      user: "u1",
      expiresAt: now + 60_000, // not expired
    });

    const result = sweep(testDb.db, now);

    expect(result.claimsDeleted).toBe(0);
    expect(
      journalRows(testDb).filter((r) => r.kind === "claim.expired"),
    ).toEqual([]);
    // The live claim survives.
    const remaining = testDb.rawDb
      .prepare("SELECT resource FROM claims")
      .all() as { resource: string }[];
    expect(remaining.map((r) => r.resource)).toContain("task:live");
  });

  it("journals one claim.expired per holder for two owner-mode claims expiring together", () => {
    // Owner mode allows multiple holders on distinct resources; here two
    // distinct live holders both expire in the same sweep. Each must get its
    // own claim.expired row (and all atomically).
    const now = Date.now();
    insertClaim(testDb, {
      resource: "task:owned-1",
      machine: "m1",
      user: "owner",
      mode: "owner",
      fence: 3,
      expiresAt: now - 1000,
    });
    insertClaim(testDb, {
      resource: "task:owned-2",
      machine: "m2",
      user: "owner",
      mode: "owner",
      fence: 9,
      expiresAt: now - 2000,
    });

    const result = sweep(testDb.db, now);

    expect(result.claimsDeleted).toBe(2);
    const expiredRows = journalRows(testDb).filter(
      (r) => r.kind === "claim.expired",
    );
    expect(expiredRows).toHaveLength(2);
    const byResource = new Map(expiredRows.map((r) => [r.resource, r]));
    expect(byResource.get("task:owned-1")?.actor).toBe("m1/owner");
    expect(byResource.get("task:owned-1")?.fence).toBe(3);
    expect(byResource.get("task:owned-2")?.actor).toBe("m2/owner");
    expect(byResource.get("task:owned-2")?.fence).toBe(9);
  });

  it("rolls back the claim.expired journal row AND the claim delete when the transaction fails (atomic)", () => {
    // Two expired claims. A BEFORE INSERT trigger on `journal` aborts when the
    // SECOND claim's journal row is inserted. Because the per-claim journal
    // append and the claim delete live in ONE transaction, that abort must roll
    // back EVERYTHING: neither claim is deleted and NO claim.expired row
    // survives — not even the first claim's, which was appended before the
    // abort. This fails if the delete or the append runs outside the tx.
    const now = Date.now();
    insertClaim(testDb, {
      resource: "task:first",
      machine: "m1",
      user: "u1",
      fence: 4,
      expiresAt: now - 5000,
    });
    insertClaim(testDb, {
      resource: "task:boom",
      machine: "m2",
      user: "u2",
      fence: 5,
      expiresAt: now - 4000,
    });

    // Implementation-agnostic forced failure: a real SQLite constraint inside
    // the transaction (independent of how appendJournal is imported/called).
    testDb.rawDb.exec(`
      CREATE TRIGGER abort_boom_journal
      BEFORE INSERT ON journal
      WHEN NEW.resource = 'task:boom' AND NEW.kind = 'claim.expired'
      BEGIN
        SELECT RAISE(ABORT, 'forced rollback');
      END;
    `);

    expect(() => sweep(testDb.db, now)).toThrow(/forced rollback/);

    // Atomicity: BOTH claims still present (neither delete committed) AND no
    // claim.expired row leaked (the first claim's append rolled back too).
    const remaining = testDb.rawDb
      .prepare("SELECT resource FROM claims ORDER BY resource")
      .all() as { resource: string }[];
    expect(remaining.map((r) => r.resource)).toEqual([
      "task:boom",
      "task:first",
    ]);
    expect(
      journalRows(testDb).filter((r) => r.kind === "claim.expired"),
    ).toEqual([]);
  });

  it("still deletes expired claims (the delete is not lost when journaling is added)", () => {
    const now = Date.now();
    insertClaim(testDb, {
      resource: "task:gone",
      machine: "m1",
      user: "u1",
      expiresAt: now - 1,
    });

    sweep(testDb.db, now);

    const expiredAfter = testDb.db
      .select()
      .from(schema.claims)
      .where(lte(schema.claims.expires_at, now))
      .all();
    expect(expiredAfter).toHaveLength(0);
  });
});
