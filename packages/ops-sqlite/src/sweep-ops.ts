import { lt, lte, sql } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { deleteTombstonedPointers } from "./artifact-ops";
import { appendJournal } from "./journal-ops";
import * as schema from "./schema";

/**
 * Grace window before a tombstoned artifact pointer is hard-deleted.
 * After tombstoning, the pointer remains observable (e.g. for reconcile) for
 * this duration. Default: 7 days in milliseconds.
 */
export const TOMBSTONE_GRACE_MS = 7 * 24 * 60 * 60 * 1000; // 604_800_000

/**
 * TTL for DO-side idempotency dedup rows in _do_idempotency.
 * Chosen constant (no D1 idempotency TTL exists to mirror). 7 days is
 * conservative-by-large-margin vs any client/SDK retry horizon, so a replayed
 * idempotency key still finds its dedup row well within the window — preserving
 * the crash-replay guard established by PR #70.
 */
export const DO_IDEMPOTENCY_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 604_800_000

export interface SweepResult {
  claimsDeleted: number;
  presenceDeleted: number;
  signalsDeleted: number;
  tombstonedPointersDeleted: number;
  doIdempotencyDeleted: number;
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
    // B3: lease expiry is the most important coordination transition, so it
    // must leave an audit trace. SELECT the expired claims first to recover each
    // claim's resource/holder/fence, append one `claim.expired` journal row per
    // claim, THEN delete — all inside this transaction so the journal rows and
    // the delete commit (or roll back) atomically. The actor is the claim's
    // holder (whose lease lapsed); the sweep is system-initiated, so there is no
    // client provenance (tokenId/source left null).
    const expiredClaims = tx
      .select()
      .from(schema.claims)
      .where(lte(schema.claims.expires_at, now))
      .all();

    for (const claim of expiredClaims) {
      appendJournal(tx, {
        kind: "claim.expired",
        resource: claim.resource,
        actor: claim.holder,
        fence: claim.fence,
        data: { mode: claim.mode, expired_at: claim.expires_at },
      });
    }

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

    // Prune stale DO idempotency dedup rows older than the TTL.
    // readChanges(tx) must immediately follow this DELETE with no intervening DML.
    tx.delete(schema.doIdempotency)
      .where(lt(schema.doIdempotency.created_at, now - DO_IDEMPOTENCY_TTL_MS))
      .run();
    const doIdempotencyDeleted = readChanges(tx);

    return {
      claimsDeleted,
      presenceDeleted,
      signalsDeleted: expiredDeleted + ackedDeleted,
      tombstonedPointersDeleted,
      doIdempotencyDeleted,
    };
  });
}
