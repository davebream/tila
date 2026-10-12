import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { idempotency } from "./schema";

export interface IdempotencyStoreLike {
  check(
    key: string,
    projectId: string,
  ): Promise<{
    statusCode: number;
    body: string;
    requestHash: string | null;
  } | null>;
  store(
    key: string,
    projectId: string,
    statusCode: number,
    responseJson: string,
    requestHash?: string | null,
  ): Promise<void>;
  /**
   * Atomically reserve `key`, or report the current holder. A placeholder row
   * carries `status_code = 0` (the in-flight sentinel); finalized rows carry
   * `status_code >= 200`. A placeholder older than `staleMs` is stolen.
   */
  reserve(
    key: string,
    projectId: string,
    nowMs: number,
    staleMs: number,
  ): Promise<
    | { state: "acquired" }
    | { state: "in-flight" }
    | { state: "finalized"; statusCode: number; body: string }
  >;
  /** Finalize a reserved placeholder. Returns false if the reservation was lost/stolen. */
  finalize(
    key: string,
    projectId: string,
    statusCode: number,
    responseJson: string,
  ): Promise<boolean>;
  /** Release a reservation (failure path); deletes only `status_code = 0` placeholders. */
  release(key: string): Promise<void>;
}

export class D1IdempotencyStore implements IdempotencyStoreLike {
  private drizzle;

  constructor(private db: D1Database) {
    this.drizzle = drizzle(this.db);
  }

  async check(
    key: string,
    projectId: string,
  ): Promise<{
    statusCode: number;
    body: string;
    requestHash: string | null;
  } | null> {
    const rows = await this.drizzle
      .select({
        statusCode: idempotency.status_code,
        body: idempotency.response_json,
        requestHash: idempotency.request_hash,
      })
      .from(idempotency)
      .where(
        and(eq(idempotency.key, key), eq(idempotency.project_id, projectId)),
      )
      .limit(1);

    if (!rows[0]) return null;
    return {
      statusCode: rows[0].statusCode,
      body: rows[0].body,
      requestHash: rows[0].requestHash ?? null,
    };
  }

  async store(
    key: string,
    projectId: string,
    statusCode: number,
    responseJson: string,
    requestHash?: string | null,
  ): Promise<void> {
    await this.drizzle
      .insert(idempotency)
      .values({
        key,
        project_id: projectId,
        created_at: Date.now(),
        response_json: responseJson,
        status_code: statusCode,
        request_hash: requestHash ?? null,
      })
      .onConflictDoNothing();
  }

  /** Reservation status_code sentinel: 0 → in-flight placeholder; >= 200 → finalized. */
  async reserve(
    key: string,
    projectId: string,
    nowMs: number,
    staleMs: number,
  ): Promise<
    | { state: "acquired" }
    | { state: "in-flight" }
    | { state: "finalized"; statusCode: number; body: string }
  > {
    const staleBefore = nowMs - staleMs;
    // Insert a fresh placeholder, OR steal an abandoned one. The WHERE on the
    // conflict target makes the steal conditional and atomic in one statement.
    const res = await this.db
      .prepare(
        `INSERT INTO _idempotency (key, project_id, created_at, response_json, status_code)
         VALUES (?, ?, ?, '', 0)
         ON CONFLICT(key) DO UPDATE SET created_at = excluded.created_at
         WHERE _idempotency.status_code = 0 AND _idempotency.created_at < ?`,
      )
      .bind(key, projectId, nowMs, staleBefore)
      .run();
    if ((res.meta?.changes ?? 0) > 0) return { state: "acquired" };
    // changes === 0: a finalized/fresh-placeholder row blocked the upsert, OR the
    // row vanished between the upsert and our read (cron GC / stale-delete).
    const row = await this.check(key, projectId);
    if (!row) {
      // Vanished — we hold NO reservation row, so we must NOT claim "acquired".
      // Retry so acquisition always corresponds to a row we actually changed.
      return this.reserve(key, projectId, nowMs, staleMs);
    }
    if (row.statusCode === 0) return { state: "in-flight" };
    return { state: "finalized", statusCode: row.statusCode, body: row.body };
  }

  /**
   * Finalize a reserved placeholder with the real response. Guarded on
   * status_code = 0 so it can never overwrite an already-finalized row.
   * Returns true iff the placeholder we held was updated (false = lost/stolen).
   */
  async finalize(
    key: string,
    _projectId: string,
    statusCode: number,
    responseJson: string,
  ): Promise<boolean> {
    const res = await this.db
      .prepare(
        "UPDATE _idempotency SET status_code = ?, response_json = ? WHERE key = ? AND status_code = 0",
      )
      .bind(statusCode, responseJson, key)
      .run();
    return (res.meta?.changes ?? 0) > 0;
  }

  /** Release a reservation (failure path) so a legitimate retry can proceed. */
  async release(key: string): Promise<void> {
    await this.db
      .prepare("DELETE FROM _idempotency WHERE key = ? AND status_code = 0")
      .bind(key)
      .run();
  }
}
