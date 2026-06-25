import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { deploymentMeta } from "./schema";

/**
 * Thrown by `ensure()` when the deployment id row is unexpectedly absent even
 * after the idempotent backfill attempt. This indicates a real D1 failure
 * (write succeeded but the subsequent SELECT returned nothing), not a logic
 * case. Callers must handle this explicitly — see the accessor↔caller error
 * contract in design C2.
 */
export class DeploymentIdUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeploymentIdUnavailable";
  }
}

/**
 * D1 accessor for the `_deployment_meta` singleton table.
 *
 * Three methods:
 *  - `get()` — read-only; returns null when the row is absent.
 *  - `ensure()` — idempotent backfill: inserts a fresh UUID if absent, then
 *    reads and returns the surviving row. Throws `DeploymentIdUnavailable` on
 *    a real D1 failure (row still absent after insert+select).
 *  - `seed(instanceId)` — writes a caller-supplied id; used by CLI provision
 *    so a specific id is planted before the first request.
 *
 * Both `ensure()` and `seed()` are `ON CONFLICT(id) DO NOTHING`-idempotent:
 * the first writer wins; re-provision or concurrent backfill never changes the
 * id (and therefore never invalidates a cached value).
 */
export class D1DeploymentMetaStore {
  private db;
  private rawDb: D1Database;

  constructor(d1: D1Database) {
    this.rawDb = d1;
    this.db = drizzle(d1);
  }

  /**
   * Returns the current instance_id or null if the singleton row is absent.
   */
  async get(): Promise<string | null> {
    const rows = await this.db
      .select()
      .from(deploymentMeta)
      .where(eq(deploymentMeta.id, 1))
      .limit(1);

    if (rows.length === 0) return null;
    return rows[0].instance_id;
  }

  /**
   * Idempotent backfill. Reads first; if absent, inserts a fresh UUID via
   * `ON CONFLICT(id) DO NOTHING`, then reads again. The post-insert SELECT
   * resolves the concurrent-backfill race: both racers converge on whichever
   * row won the INSERT conflict, because D1 guarantees read-your-writes within
   * the same request session. Throws `DeploymentIdUnavailable` if the row is
   * still absent after the insert (a real D1 failure, not a logic case).
   */
  async ensure(): Promise<string> {
    const existing = await this.get();
    if (existing !== null) return existing;

    // Backfill — plain PK conflict target (no partial index needed for id=1).
    await this.rawDb
      .prepare(
        "INSERT INTO _deployment_meta (id, instance_id, created_at) VALUES (1, ?, ?) ON CONFLICT(id) DO NOTHING",
      )
      .bind(crypto.randomUUID(), Date.now())
      .run();

    const after = await this.get();
    if (after === null) {
      throw new DeploymentIdUnavailable(
        "deployment instance_id unavailable: row absent after backfill INSERT",
      );
    }
    return after;
  }

  /**
   * Plants a caller-supplied instance id. Used by CLI provision (C7) so a
   * specific id is seeded before the first request. `ON CONFLICT DO NOTHING`
   * guarantees a re-provision never overwrites an existing id.
   */
  async seed(instanceId: string): Promise<void> {
    await this.rawDb
      .prepare(
        "INSERT INTO _deployment_meta (id, instance_id, created_at) VALUES (1, ?, ?) ON CONFLICT(id) DO NOTHING",
      )
      .bind(instanceId, Date.now())
      .run();
  }
}
