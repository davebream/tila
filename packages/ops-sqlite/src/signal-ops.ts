import { and, eq, gt, or } from "drizzle-orm";
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
      ),
    )
    .all()
    .map((row) => ({
      ...row,
      payload: JSON.parse(row.payload),
    }));
}

export function ack(
  db: BaseSQLiteDatabase<"sync", unknown, typeof schema>,
  signalId: string,
  now: number = Date.now(),
): AckSignalResult {
  const existing = db
    .select()
    .from(schema.signals)
    .where(eq(schema.signals.id, signalId))
    .get();

  if (!existing) {
    return { found: false };
  }

  db.update(schema.signals)
    .set({ acked_at: now })
    .where(eq(schema.signals.id, signalId))
    .run();

  return { found: true };
}
