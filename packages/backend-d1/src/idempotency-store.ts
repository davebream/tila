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
}
