import { lte, sql } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { deleteTombstonedPointers } from "./artifact-ops";
import * as schema from "./schema";

/**
 * Grace window before a tombstoned artifact pointer is hard-deleted.
 * After tombstoning, the pointer remains observable (e.g. for reconcile) for
 * this duration. Default: 7 days in milliseconds.
 */
export const TOMBSTONE_GRACE_MS = 7 * 24 * 60 * 60 * 1000; // 604_800_000

export interface SweepResult {
  claimsDeleted: number;
  presenceDeleted: number;
  signalsDeleted: number;
  tombstonedPointersDeleted: number;
}

/** Read the row-change count from the last DML statement in a transaction. */
function readChanges(
  tx: BaseSQLiteDatabase<"sync", unknown, typeof schema>,
): number {
  // SQLite names the column "changes()" (with parentheses); use an alias to normalize.
  return tx.get<{ n: number }>(sql`SELECT changes() AS n`)?.n ?? 0;
}

export function sweep(
  db: BaseSQLiteDatabase<"sync", unknown, typeof schema>,
  now: number = Date.now(),
  presenceTtlMs = 60_000,
): SweepResult {
  const tombstonedPointersDeleted = deleteTombstonedPointers(
    db,
    now - TOMBSTONE_GRACE_MS,
  );

  return db.transaction((tx) => {
    tx.delete(schema.claims).where(lte(schema.claims.expires_at, now)).run();
    const claimsDeleted = readChanges(tx);

    const presenceCutoff = now - presenceTtlMs;
    tx.delete(schema.presence)
      .where(lte(schema.presence.last_seen, presenceCutoff))
      .run();
    const presenceDeleted = readChanges(tx);

    // Delete expired signals
    tx.delete(schema.signals).where(lte(schema.signals.expires_at, now)).run();
    const expiredDeleted = readChanges(tx);

    // Delete acked signals (those not already deleted by the expired pass)
    tx.run(sql`DELETE FROM signals WHERE acked_at IS NOT NULL`);
    const ackedDeleted = readChanges(tx);

    return {
      claimsDeleted,
      presenceDeleted,
      signalsDeleted: expiredDeleted + ackedDeleted,
      tombstonedPointersDeleted,
    };
  });
}
