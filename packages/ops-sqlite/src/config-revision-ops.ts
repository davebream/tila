import { eq, sql } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import * as schema from "./schema";

type DB = BaseSQLiteDatabase<"sync", unknown, typeof schema>;

/**
 * A conditional settings write named a revision other than the current one.
 * `revision` is the current value (null when the resource does not exist) so
 * an editor can reload and rebase. Maps to HTTP 412 `revision-conflict`.
 */
export class RevisionConflictError extends Error {
  readonly code = "revision-conflict";
  constructor(
    readonly resource: string,
    readonly revision: number | null,
  ) {
    super(
      revision === null
        ? `${resource} does not exist`
        : `${resource} changed; current revision is ${revision}`,
    );
    this.name = "RevisionConflictError";
  }
}

/**
 * Allocate the next settings revision for agents, rooms and signal groups.
 * One project-wide counter means a deleted and recreated resource never reuses
 * a revision a stale editor still holds. Call inside the write transaction.
 */
export function nextRevision(tx: DB): number {
  const row = tx
    .update(schema.configRevisionSeq)
    .set({ value: sql`${schema.configRevisionSeq.value} + 1` })
    .where(eq(schema.configRevisionSeq.singleton, 1))
    .returning({ value: schema.configRevisionSeq.value })
    .get();
  if (row) return row.value;
  tx.insert(schema.configRevisionSeq)
    .values({ singleton: 1, value: 2 })
    .onConflictDoNothing()
    .run();
  return 2;
}

/** Throw unless `expected` matches the current revision (`null` = absent). */
export function checkRevision(
  resource: string,
  current: number | null,
  expected: number,
): void {
  if (current === null ? expected !== 0 : current !== expected)
    throw new RevisionConflictError(resource, current);
}

/**
 * Restored rows keep their source revisions; re-stamp them from this project's
 * counter so an editor holding a pre-restore revision always conflicts.
 */
export function refreshRestoredRevisions(tx: DB): void {
  for (const { id } of tx
    .select({ id: schema.agents.id })
    .from(schema.agents)
    .all())
    tx.update(schema.agents)
      .set({ revision: nextRevision(tx) })
      .where(eq(schema.agents.id, id))
      .run();
  for (const { id } of tx
    .select({ id: schema.rooms.id })
    .from(schema.rooms)
    .all())
    tx.update(schema.rooms)
      .set({ revision: nextRevision(tx) })
      .where(eq(schema.rooms.id, id))
      .run();
  for (const { id } of tx
    .select({ id: schema.signalGroups.id })
    .from(schema.signalGroups)
    .all())
    tx.update(schema.signalGroups)
      .set({ revision: nextRevision(tx) })
      .where(eq(schema.signalGroups.id, id))
      .run();
}
