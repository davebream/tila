/**
 * sweepExpiredKey — extracted for unit testability (C5 ordering invariant).
 *
 * Ordering contract:
 *   1. Tombstone the DO pointer FIRST — makes the pointer non-live.
 *   2. Delete the R2 blob (single retry) ONLY when tombstone succeeded.
 *
 * A failed tombstone increments r2DeleteErrors and skips R2 delete.
 * A failed R2 delete (both attempts) increments r2DeleteErrors; the pointer
 * remains tombstoned (non-live), so the orphan blob is recoverable by reconcile.
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

  try {
    await r2Delete(key);
    summary.artifactsExpired++;
  } catch (_firstErr) {
    // Single retry
    try {
      await r2Delete(key);
      summary.artifactsExpired++;
    } catch (err) {
      console.error(`[sweep] failed to delete R2 blob ${key}:`, err);
      summary.r2DeleteErrors++;
    }
  }
}
