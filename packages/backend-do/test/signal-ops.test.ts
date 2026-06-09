import {
  MIGRATION_0001,
  MIGRATION_0007,
  MIGRATION_0018,
  runMigration0016,
  schema,
  signalOps,
  sweepOps,
} from "@tila/ops-sqlite";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";

// Strip FK constraints and Cloudflare-specific SQL for standard SQLite
const MIGRATION_0001_TEST = MIGRATION_0001.replace(
  "PRIMARY KEY (from_key, COALESCE(to_key, to_uri), type)",
  "PRIMARY KEY (from_key, type)",
).replace(",\n  FOREIGN KEY (resource) REFERENCES entities(id)", "");

interface TestDb {
  db: BaseSQLiteDatabase<"sync", unknown, typeof schema>;
  sqlite: InstanceType<typeof Database>;
}

function createTestDb(): TestDb {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = OFF");
  sqlite.exec(MIGRATION_0001_TEST);
  sqlite.exec(MIGRATION_0007);
  sqlite.exec(MIGRATION_0018); // entity_tags + artifact_tags tables
  runMigration0016({
    sql: {
      exec<T>(statement: string) {
        if (/^\s*(SELECT|PRAGMA)\b/i.test(statement)) {
          return { toArray: () => sqlite.prepare(statement).all() as T[] };
        }
        sqlite.exec(statement);
        return { toArray: () => [] as T[] };
      },
    },
  });
  const db = drizzle(sqlite, { schema }) as unknown as BaseSQLiteDatabase<
    "sync",
    unknown,
    typeof schema
  >;
  return { db, sqlite };
}

describe("signal-ops", () => {
  describe("send", () => {
    it("returns a sig_-prefixed ID and inserts a row", () => {
      const { db } = createTestDb();
      const result = signalOps.send(db, {
        target: "machine-B",
        kind: "conflict",
        created_by: "machine-A",
      });
      expect(result.id).toMatch(/^sig_/);

      const rows = signalOps.inbox(db, "machine-B");
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(result.id);
      expect(rows[0].kind).toBe("conflict");
      expect(rows[0].created_by).toBe("machine-A");
    });

    it("stores payload as parsed JSON", () => {
      const { db } = createTestDb();
      signalOps.send(db, {
        target: "machine-B",
        kind: "info",
        payload: { details: "something" },
        created_by: "machine-A",
      });

      const rows = signalOps.inbox(db, "machine-B");
      expect(rows[0].payload).toEqual({ details: "something" });
    });

    it("uses default TTL of 5 minutes", () => {
      const { db } = createTestDb();
      const now = 1000000;
      signalOps.send(
        db,
        { target: "machine-B", kind: "info", created_by: "machine-A" },
        now,
      );

      const rows = signalOps.inbox(db, "machine-B", now);
      expect(rows[0].expires_at).toBe(now + 300_000);
    });
  });

  describe("inbox", () => {
    it("returns signals targeted to the querying token", () => {
      const { db } = createTestDb();
      signalOps.send(db, {
        target: "machine-B",
        kind: "conflict",
        created_by: "machine-A",
      });
      signalOps.send(db, {
        target: "machine-C",
        kind: "info",
        created_by: "machine-A",
      });

      const inbox = signalOps.inbox(db, "machine-B");
      expect(inbox).toHaveLength(1);
      expect(inbox[0].target).toBe("machine-B");
    });

    it("includes broadcast signals (target = '*')", () => {
      const { db } = createTestDb();
      signalOps.send(db, {
        target: "*",
        kind: "ready",
        created_by: "machine-A",
      });

      const inboxB = signalOps.inbox(db, "machine-B");
      const inboxC = signalOps.inbox(db, "machine-C");
      expect(inboxB).toHaveLength(1);
      expect(inboxC).toHaveLength(1);
    });

    it("excludes expired signals", () => {
      const { db } = createTestDb();
      const now = 1000000;
      signalOps.send(
        db,
        {
          target: "machine-B",
          kind: "info",
          ttl_ms: 100,
          created_by: "machine-A",
        },
        now,
      );

      // Query after expiry
      const inbox = signalOps.inbox(db, "machine-B", now + 200);
      expect(inbox).toHaveLength(0);
    });

    it("includes acked signals (filtering is consumer concern)", () => {
      const { db } = createTestDb();
      const result = signalOps.send(db, {
        target: "machine-B",
        kind: "info",
        created_by: "machine-A",
      });
      signalOps.ack(db, result.id);

      const inbox = signalOps.inbox(db, "machine-B");
      expect(inbox).toHaveLength(1);
      expect(inbox[0].acked_at).not.toBeNull();
    });
  });

  describe("ack", () => {
    it("sets acked_at for an existing signal", () => {
      const { db } = createTestDb();
      const now = 1000000;
      const result = signalOps.send(
        db,
        { target: "machine-B", kind: "info", created_by: "machine-A" },
        now,
      );

      const ackResult = signalOps.ack(db, result.id, now + 1000);
      expect(ackResult.found).toBe(true);

      const inbox = signalOps.inbox(db, "machine-B", now + 1000);
      expect(inbox[0].acked_at).toBe(now + 1000);
    });

    it("returns { found: false } for unknown ID", () => {
      const { db } = createTestDb();
      const result = signalOps.ack(db, "sig_nonexistent");
      expect(result.found).toBe(false);
    });

    it("is idempotent on re-ack (updates timestamp)", () => {
      const { db } = createTestDb();
      const now = 1000000;
      const result = signalOps.send(
        db,
        { target: "machine-B", kind: "info", created_by: "machine-A" },
        now,
      );

      signalOps.ack(db, result.id, now + 1000);
      signalOps.ack(db, result.id, now + 2000);

      const inbox = signalOps.inbox(db, "machine-B", now + 2000);
      expect(inbox[0].acked_at).toBe(now + 2000);
    });
  });
});

describe("sweep signals", () => {
  it("deletes expired signals", () => {
    const { db } = createTestDb();
    const now = 1000000;
    signalOps.send(
      db,
      {
        target: "machine-B",
        kind: "info",
        ttl_ms: 100,
        created_by: "machine-A",
      },
      now,
    );

    const result = sweepOps.sweep(db, now + 200);
    expect(result.signalsDeleted).toBe(1);

    const inbox = signalOps.inbox(db, "machine-B", now + 200);
    expect(inbox).toHaveLength(0);
  });

  it("deletes acked signals", () => {
    const { db } = createTestDb();
    const now = 1000000;
    const sig = signalOps.send(
      db,
      { target: "machine-B", kind: "info", created_by: "machine-A" },
      now,
    );
    signalOps.ack(db, sig.id, now + 100);

    const result = sweepOps.sweep(db, now + 200);
    expect(result.signalsDeleted).toBeGreaterThanOrEqual(1);
  });

  it("does not delete unacked, non-expired signals", () => {
    const { db } = createTestDb();
    const now = 1000000;
    signalOps.send(
      db,
      { target: "machine-B", kind: "info", created_by: "machine-A" },
      now,
    );

    const result = sweepOps.sweep(db, now + 100);
    expect(result.signalsDeleted).toBe(0);

    const inbox = signalOps.inbox(db, "machine-B", now + 100);
    expect(inbox).toHaveLength(1);
  });

  it("preserves existing claimsDeleted and presenceDeleted counts", () => {
    const { db } = createTestDb();
    const result = sweepOps.sweep(db);
    expect(result).toHaveProperty("claimsDeleted");
    expect(result).toHaveProperty("presenceDeleted");
    expect(result).toHaveProperty("signalsDeleted");
  });
});
