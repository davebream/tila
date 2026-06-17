/**
 * Unit tests for the in-transaction DO idempotency dedup helper (audit B1).
 *
 * The helper co-commits a dedup row with a fence-mutating write so a replay of
 * the same Idempotency-Key returns the stored result WITHOUT re-running the
 * write (no second fence bump). These tests exercise the helper in isolation:
 * miss runs compute + stores; hit skips compute + returns stored; hash mismatch
 * throws; non-mutating outcomes are not stored.
 */
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { beforeEach, describe, expect, it } from "vitest";
import {
  DoIdempotencyConflictError,
  withDoIdempotency,
} from "../src/do-idempotency-ops";
import * as schema from "../src/schema";

function createDb(): BaseSQLiteDatabase<"sync", unknown, typeof schema> {
  const raw = new Database(":memory:");
  raw.exec(`
    CREATE TABLE _do_idempotency (
      key           TEXT PRIMARY KEY,
      request_hash  TEXT,
      status_code   INTEGER NOT NULL,
      response_json TEXT NOT NULL,
      created_at    INTEGER NOT NULL
    );
  `);
  return drizzle(raw, { schema }) as unknown as BaseSQLiteDatabase<
    "sync",
    unknown,
    typeof schema
  >;
}

describe("withDoIdempotency", () => {
  let db: BaseSQLiteDatabase<"sync", unknown, typeof schema>;

  beforeEach(() => {
    db = createDb();
  });

  it("no idempotency context → runs compute unchanged, stores nothing", () => {
    let calls = 0;
    const out = db.transaction((tx) =>
      withDoIdempotency(tx, undefined, () => {
        calls++;
        return { v: 1 };
      }),
    );
    expect(out).toEqual({ result: { v: 1 }, replayed: false });
    expect(calls).toBe(1);
    const rows = db.select().from(schema.doIdempotency).all();
    expect(rows).toHaveLength(0);
  });

  it("miss → runs compute and persists the serialized result", () => {
    const idem = { key: "k1", requestHash: "h1" };
    const out = db.transaction((tx) =>
      withDoIdempotency(tx, idem, () => ({ v: 42 })),
    );
    expect(out.replayed).toBe(false);
    expect(out.result).toEqual({ v: 42 });
    const row = db
      .select()
      .from(schema.doIdempotency)
      .where(eq(schema.doIdempotency.key, "k1"))
      .get();
    expect(row?.request_hash).toBe("h1");
    expect(JSON.parse(row?.response_json ?? "null")).toEqual({ v: 42 });
  });

  it("hit with matching hash → SKIPS compute, returns the stored result", () => {
    const idem = { key: "k1", requestHash: "h1" };
    db.transaction((tx) => withDoIdempotency(tx, idem, () => ({ v: "first" })));

    let secondCalls = 0;
    const out = db.transaction((tx) =>
      withDoIdempotency(tx, idem, () => {
        secondCalls++;
        return { v: "second" };
      }),
    );
    expect(secondCalls).toBe(0); // compute never ran on replay
    expect(out.replayed).toBe(true);
    expect(out.result).toEqual({ v: "first" }); // original, not "second"
  });

  it("hit with a NULL stored hash → always replays", () => {
    const idem = { key: "k1", requestHash: null };
    db.transaction((tx) => withDoIdempotency(tx, idem, () => ({ v: "first" })));

    let calls = 0;
    const out = db.transaction((tx) =>
      withDoIdempotency(
        tx,
        { key: "k1", requestHash: "now-has-a-hash" },
        () => {
          calls++;
          return { v: "second" };
        },
      ),
    );
    expect(calls).toBe(0);
    expect(out.replayed).toBe(true);
    expect(out.result).toEqual({ v: "first" });
  });

  it("hit with a different hash → throws DoIdempotencyConflictError", () => {
    db.transaction((tx) =>
      withDoIdempotency(tx, { key: "k1", requestHash: "h1" }, () => ({ v: 1 })),
    );
    expect(() =>
      db.transaction((tx) =>
        withDoIdempotency(tx, { key: "k1", requestHash: "DIFFERENT" }, () => ({
          v: 2,
        })),
      ),
    ).toThrow(DoIdempotencyConflictError);
  });

  it("shouldStore=false → runs compute but does NOT persist (non-mutating outcome)", () => {
    const idem = {
      key: "k1",
      requestHash: "h1",
      shouldStore: (r: { ok: boolean }) => r.ok,
    };
    const out = db.transaction((tx) =>
      withDoIdempotency(tx, idem, () => ({ ok: false })),
    );
    expect(out.replayed).toBe(false);
    const rows = db.select().from(schema.doIdempotency).all();
    expect(rows).toHaveLength(0);
  });
});
