import { and, eq, gt, isNull, or } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import * as schema from "./schema";

export interface SendSignalParams {
  target: string;
  kind: string;
  resource?: string;
  payload?: unknown;
  ttl_ms?: number;
  created_by: string;
}

export interface SendSignalResult {
  id: string;
}

export interface AckSignalResult {
  found: boolean;
  /**
   * Whether the caller was authorized to ack this signal. A signal may be
   * acked only by its addressee (`target`), the original sender (`created_by`),
   * or anyone for a broadcast (`target === "*"`). When `false`, the signal is
   * left untouched so the real recipient still sees it.
   */
  authorized: boolean;
}

const DEFAULT_TTL_MS = 300_000; // 5 minutes

export function send(
  db: BaseSQLiteDatabase<"sync", unknown, typeof schema>,
  params: SendSignalParams,
  now: number = Date.now(),
): SendSignalResult {
  const id = `sig_${crypto.randomUUID()}`;
  const ttl = params.ttl_ms ?? DEFAULT_TTL_MS;

  db.transaction((tx) => {
    tx.insert(schema.signals)
      .values({
        id,
        target: params.target,
        kind: params.kind,
        resource: params.resource ?? null,
        payload: JSON.stringify(params.payload ?? {}),
        created_by: params.created_by,
        created_at: now,
        expires_at: now + ttl,
        acked_at: null,
      })
      .run();
  });

  return { id };
}

export function inbox(
  db: BaseSQLiteDatabase<"sync", unknown, typeof schema>,
  tokenName: string,
  now: number = Date.now(),
) {
  return db
    .select()
    .from(schema.signals)
    .where(
      and(
        or(
          eq(schema.signals.target, tokenName),
          eq(schema.signals.target, "*"),
        ),
        gt(schema.signals.expires_at, now),
        // Acked signals are consumed: an "inbox" returns only unacknowledged
        // signals. Filtering here (server-side) keeps SDK/MCP consumers
        // consistent with the CLI, which already drops acked rows.
        isNull(schema.signals.acked_at),
      ),
    )
    .all()
    .map((row) => ({
      ...row,
      payload: JSON.parse(row.payload),
    }));
}

/**
 * Acknowledge (consume) a signal on behalf of `acker`.
 *
 * Authorization: a signal may be acked only by its addressee (`target`), the
 * original sender (`created_by`), or anyone when it is a broadcast
 * (`target === "*"`). An unauthorized ack is a no-op — the signal is left
 * unacknowledged so the real recipient still receives it — and returns
 * `{ found: true, authorized: false }`. This closes the coordination-integrity
 * hole where any project token could silently consume another machine's signal.
 */
export function ack(
  db: BaseSQLiteDatabase<"sync", unknown, typeof schema>,
  signalId: string,
  acker: string,
  now: number = Date.now(),
): AckSignalResult {
  // Wrap the select + update in one transaction with a `WHERE acked_at IS NULL`
  // guard so a concurrent or repeated ack is idempotent: the first ack stamps
  // `acked_at`; any later ack updates 0 rows and leaves the original timestamp
  // intact. Without the transaction + guard, two acks racing in an embedded
  // multi-process backend could each read a null `acked_at` and both write,
  // clobbering the first timestamp.
  return db.transaction((tx) => {
    const existing = tx
      .select()
      .from(schema.signals)
      .where(eq(schema.signals.id, signalId))
      .get();

    if (!existing) {
      return { found: false, authorized: false };
    }

    const authorized =
      existing.target === acker ||
      existing.target === "*" ||
      existing.created_by === acker;

    if (!authorized) {
      return { found: true, authorized: false };
    }

    tx.update(schema.signals)
      .set({ acked_at: now })
      .where(
        and(eq(schema.signals.id, signalId), isNull(schema.signals.acked_at)),
      )
      .run();

    return { found: true, authorized: true };
  });
}
