/**
 * sweepExpiredKey — extracted for unit testability (C5 ordering invariant).
 *
 * Ordering contract:
 *   1. Tombstone the DO pointer FIRST — makes the pointer non-live.
 *   2. Delete the R2 blob (single retry) ONLY when tombstone succeeded.
 *   3. Confirm the blob deletion back to the DO ONLY when the R2 delete
 *      succeeded — this stamps blob_deleted_at so the pointer row becomes
 *      eligible for the grace-window hard-delete.
 *
 * A failed tombstone increments r2DeleteErrors and skips R2 delete.
 * A failed R2 delete (both attempts) increments r2DeleteErrors; the pointer
 * remains tombstoned (non-live) and UNCONFIRMED, so it is not hard-deleted and
 * the orphan blob stays recoverable by reconcile (Finding #2).
 */
export async function sweepExpiredKey(
  key: string,
  doStub: {
    fetch(req: Request | string, init?: RequestInit): Promise<Response>;
  },
  r2Delete: (key: string) => Promise<void>,
  summary: { artifactsExpired: number; r2DeleteErrors: number },
): Promise<void> {
  let tombstoned = false;
  try {
    await doStub.fetch("http://do/artifact/tombstone", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        r2_key: key,
        actor: "sweep-cron",
        journal_kind: "artifact.expired",
      }),
    });
    tombstoned = true;
  } catch (err) {
    console.error(`[sweep] failed to tombstone key ${key}:`, err);
    summary.r2DeleteErrors++;
  }

  if (!tombstoned) return;

  let deleted = false;
  try {
    await r2Delete(key);
    deleted = true;
  } catch (_firstErr) {
    // Single retry
    try {
      await r2Delete(key);
      deleted = true;
    } catch (err) {
      console.error(`[sweep] failed to delete R2 blob ${key}:`, err);
      summary.r2DeleteErrors++;
    }
  }

  if (!deleted) return;
  summary.artifactsExpired++;

  // Confirm the blob deletion so the DO can later hard-delete the pointer row.
  // Non-fatal: a failed confirm just leaves the row pending until a future
  // sweep re-confirms (the blob is already gone, so re-delete is idempotent).
  try {
    await doStub.fetch("http://do/artifact/confirm-blob-deleted", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ r2_key: key }),
    });
  } catch (err) {
    console.error(`[sweep] failed to confirm blob deletion for ${key}:`, err);
  }
}
