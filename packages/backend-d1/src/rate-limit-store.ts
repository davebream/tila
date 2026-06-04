import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { rateLimits } from "./schema";

export interface RateLimitStoreInterface {
  /** Returns true if the IP is rate-limited (failures >= maxFailures within windowMs). */
  check(ip: string, maxFailures: number, windowMs: number): Promise<boolean>;
  /** Records an auth failure for the IP. Resets window if expired. */
  recordFailure(ip: string, windowMs: number): Promise<void>;
}

export class D1RateLimitStore implements RateLimitStoreInterface {
  private drizzle;

  constructor(private db: D1Database) {
    this.drizzle = drizzle(this.db);
  }

  async check(
    ip: string,
    maxFailures: number,
    windowMs: number,
  ): Promise<boolean> {
    const now = Date.now();
    const rows = await this.drizzle
      .select({
        count: rateLimits.count,
        window_start: rateLimits.window_start,
      })
      .from(rateLimits)
      .where(eq(rateLimits.ip, ip))
      .limit(1);

    const row = rows[0];
    if (!row) return false;
    if (now - row.window_start > windowMs) return false;
    return row.count >= maxFailures;
  }

  async recordFailure(ip: string, windowMs: number): Promise<void> {
    const now = Date.now();
    const rows = await this.drizzle
      .select({
        count: rateLimits.count,
        window_start: rateLimits.window_start,
      })
      .from(rateLimits)
      .where(eq(rateLimits.ip, ip))
      .limit(1);

    const row = rows[0];

    if (!row || now - row.window_start > windowMs) {
      // No existing row or window expired — insert/replace with count=1
      await this.db
        .prepare(
          "INSERT OR REPLACE INTO _rate_limits (ip, count, window_start) VALUES (?, ?, ?)",
        )
        .bind(ip, 1, now)
        .run();
    } else {
      // Window active — increment count
      await this.db
        .prepare(
          "INSERT OR REPLACE INTO _rate_limits (ip, count, window_start) VALUES (?, ?, ?)",
        )
        .bind(ip, row.count + 1, row.window_start)
        .run();
    }
  }
}
