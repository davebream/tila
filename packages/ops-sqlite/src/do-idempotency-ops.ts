import { eq } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import * as schema from "./schema";

// ---------------------------------------------------------------------------
// DO-side idempotency dedup — co-committed with the fence-mutating write.
//
// The worker idempotency middleware records a dedup row in D1 *after* the DO
// write commits (cross-store). If the process crashes between the DO commit and
// the D1 store, a retry finds no D1 row and re-executes the handler, double-
// applying a fence-mutating write (a second fence bump). To close that window,
// the DO records "this key already produced this result" inside the SAME DO
// SQLite transaction as the write. A replay then hits this dedup row and returns
// the prior result WITHOUT re-executing. The D1 row remains a fast-path
// optimization, no longer the sole guard.
//
// See audit finding B1 and docs/01-DECISIONS.md (correctness model).
// ---------------------------------------------------------------------------

/**
 * Idempotency context threaded from the worker (which already computed the
 * caller-scoped key and request-body hash). `key` is byte-identical to the D1
 * idempotency key so the two stores agree. `requestHash` may be null for legacy
 * callers; a null stored hash always replays (mirrors the worker middleware).
 */
export interface DoIdempotency<T> {
  key: string;
  requestHash: string | null;
  /**
   * Serialize the op's domain result into the value to persist for replay.
   * Defaults to identity. The route re-shapes the returned result through its
   * normal (deterministic) serializer, so the replayed HTTP body is byte-equal
   * to the original even though we store the domain result, not the HTTP body.
   */
  serialize?: (result: T) => unknown;
  /**
   * Whether a given result represents a real (fence-mutating) write worth
   * deduping. Defaults to always-store. Used to skip storing non-mutating
   * outcomes such as a failed acquire (`{acquired:false}`) or a no-op renew,
   * which must NOT be replayed as if they had committed.
   */
  shouldStore?: (result: T) => boolean;
}

/**
 * Raised when the same Idempotency-Key is reused with a different request body.
 * Maps to HTTP 422 `idempotency-key-conflict` (see error-map.ts), matching the
 * worker idempotency middleware's conflict behavior.
 */
export class DoIdempotencyConflictError extends Error {
  constructor(key: string) {
    super(`Idempotency-Key reused with a different request body: ${key}`);
    this.name = "DoIdempotencyConflictError";
  }
}

type Tx = BaseSQLiteDatabase<"sync", unknown, typeof schema>;

/**
 * Run `compute` (the fence-mutating write) under in-transaction idempotency
 * dedup. Call this INSIDE the op's existing `db.transaction((tx) => …)` so the
 * dedup row commits atomically with the write.
 *
 * - No `idempotency` → runs `compute` unchanged (no dedup row).
 * - Replay (key present, hash matches or stored hash null) → returns the stored
 *   result and SKIPS `compute` entirely (no second fence bump).
 * - Conflict (key present, hash differs) → throws DoIdempotencyConflictError.
 * - Miss → runs `compute`, persists the serialized result keyed by `key`, and
 *   returns it.
 */
export function withDoIdempotency<T>(
  tx: Tx,
  idempotency: DoIdempotency<T> | undefined,
  compute: () => T,
): { result: T; replayed: boolean } {
  if (!idempotency) {
    return { result: compute(), replayed: false };
  }

  const { key, requestHash } = idempotency;

  const existing = tx
    .select({
      requestHash: schema.doIdempotency.request_hash,
      responseJson: schema.doIdempotency.response_json,
    })
    .from(schema.doIdempotency)
    .where(eq(schema.doIdempotency.key, key))
    .get();

  if (existing) {
    // A null stored hash matches any incoming body (legacy / hashless writers).
    if (existing.requestHash !== null && existing.requestHash !== requestHash) {
      throw new DoIdempotencyConflictError(key);
    }
    const result = JSON.parse(existing.responseJson) as T;
    return { result, replayed: true };
  }

  // Miss: run the real write (incl. fence bump) and co-commit the dedup row.
  const result = compute();

  // Skip storing non-mutating outcomes (failed acquire / no-op renew) so they
  // are never replayed as if committed; the next attempt re-evaluates live state.
  if (idempotency.shouldStore && !idempotency.shouldStore(result)) {
    return { result, replayed: false };
  }

  const serialized = idempotency.serialize
    ? idempotency.serialize(result)
    : result;

  // ON CONFLICT DO NOTHING: a concurrent writer in the same DO is serialized by
  // the single-threaded DO, but the guard keeps the insert safe under replay of
  // an already-stored key reaching this branch (it cannot, given the SELECT
  // above ran in the same tx, but the guard documents intent and is cheap).
  tx.insert(schema.doIdempotency)
    .values({
      key,
      request_hash: requestHash,
      status_code: 200,
      response_json: JSON.stringify(serialized),
      created_at: Date.now(),
    })
    .onConflictDoNothing()
    .run();

  return { result, replayed: false };
}
