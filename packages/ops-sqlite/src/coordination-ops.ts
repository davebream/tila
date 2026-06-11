import { assertFence } from "@tila/core";
import type { Claim, Presence } from "@tila/schemas";
import { eq, gt, lte, sql } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import {
  ClaimOwnershipError,
  FenceNotFoundError,
  resolveEntityResource,
} from "./fence-ops";
import { type RequestOrigin, appendJournal } from "./journal-ops";
import * as schema from "./schema";

export interface AcquireResult {
  acquired: boolean;
  fence: number;
  expires_at: number;
}

export function acquire(
  db: BaseSQLiteDatabase<"sync", unknown, typeof schema>,
  resource: string,
  machine: string,
  user: string,
  mode: "exclusive" | "owner" | "presence",
  ttlMs: number,
  metadata?: Record<string, unknown>,
  now: number = Date.now(),
  origin?: RequestOrigin,
): AcquireResult {
  return db.transaction((tx) => {
    // Canonicalize entity resources to `<type>:<id>` at the write boundary.
    // This ensures both the fence row and the claim row use the canonical form
    // regardless of whether the caller passed a bare id or the typed form.
    // Non-entity resources (records, arbitrary coordination keys) pass through
    // unchanged (resolveEntityResource returns null for them).
    const canonicalResource = resolveEntityResource(tx, resource) ?? resource;

    const existing = tx
      .select()
      .from(schema.claims)
      .where(eq(schema.claims.resource, canonicalResource))
      .get();

    if (existing && existing.expires_at > now) {
      if (existing.machine === machine && existing.user === user) {
        const expiresAt = now + ttlMs;
        tx.update(schema.claims)
          .set({ expires_at: expiresAt })
          .where(eq(schema.claims.resource, canonicalResource))
          .run();

        return {
          acquired: true,
          fence: existing.fence,
          expires_at: expiresAt,
        };
      }

      if (
        mode === "exclusive" &&
        (existing.machine !== machine || existing.user !== user)
      ) {
        return {
          acquired: false,
          fence: existing.fence,
          expires_at: 0,
        };
      }
      if (mode === "owner" && existing.user !== user) {
        return {
          acquired: false,
          fence: existing.fence,
          expires_at: 0,
        };
      }
    }

    tx.run(
      sql`INSERT INTO fences(resource, current_fence) VALUES(${canonicalResource}, 1) ON CONFLICT(resource) DO UPDATE SET current_fence = current_fence + 1`,
    );

    const fenceRow = tx
      .select()
      .from(schema.fences)
      .where(eq(schema.fences.resource, canonicalResource))
      .get();
    const newFence = fenceRow?.current_fence ?? 1;

    tx.delete(schema.claims)
      .where(eq(schema.claims.resource, canonicalResource))
      .run();

    const expiresAt = now + ttlMs;
    tx.insert(schema.claims)
      .values({
        resource: canonicalResource,
        holder: `${machine}/${user}`,
        machine,
        user,
        mode,
        fence: newFence,
        acquired_at: now,
        expires_at: expiresAt,
        metadata: JSON.stringify(metadata ?? {}),
      })
      .run();

    appendJournal(tx, {
      kind: "claim.acquired",
      resource: canonicalResource,
      actor: `${machine}/${user}`,
      fence: newFence,
      tokenId: origin?.tokenId,
      source: origin?.source,
      sourceVersion: origin?.sourceVersion,
    });

    return {
      acquired: true,
      fence: newFence,
      expires_at: expiresAt,
    };
  });
}

export interface RenewResult {
  renewed: boolean;
  expires_at: number;
}

export function renew(
  db: BaseSQLiteDatabase<"sync", unknown, typeof schema>,
  resource: string,
  machine: string,
  user: string,
  fence: number,
  ttlMs: number,
  now: number = Date.now(),
  origin?: RequestOrigin,
): RenewResult {
  return db.transaction((tx) => {
    const canonicalResource = resolveEntityResource(tx, resource) ?? resource;
    const claim = tx
      .select()
      .from(schema.claims)
      .where(eq(schema.claims.resource, canonicalResource))
      .get();

    if (!claim || claim.expires_at <= now) {
      return { renewed: false, expires_at: 0 };
    }

    if (claim.machine !== machine || claim.user !== user) {
      return { renewed: false, expires_at: 0 };
    }

    const fenceRow = tx
      .select()
      .from(schema.fences)
      .where(eq(schema.fences.resource, canonicalResource))
      .get();

    if (!fenceRow) throw new FenceNotFoundError(resource);
    assertFence(fenceRow.current_fence, fence);

    const newExpiresAt = now + ttlMs;
    tx.update(schema.claims)
      .set({ expires_at: newExpiresAt })
      .where(eq(schema.claims.resource, canonicalResource))
      .run();

    appendJournal(tx, {
      kind: "claim.renewed",
      resource: canonicalResource,
      actor: `${machine}/${user}`,
      fence,
      tokenId: origin?.tokenId,
      source: origin?.source,
      sourceVersion: origin?.sourceVersion,
    });

    return { renewed: true, expires_at: newExpiresAt };
  });
}

export function release(
  db: BaseSQLiteDatabase<"sync", unknown, typeof schema>,
  resource: string,
  fence: number,
  origin: RequestOrigin,
): void {
  db.transaction((tx) => {
    const canonicalResource = resolveEntityResource(tx, resource) ?? resource;
    const claimRow = tx
      .select()
      .from(schema.claims)
      .where(eq(schema.claims.resource, canonicalResource))
      .get();
    if (claimRow && claimRow.holder !== origin.actor) {
      throw new ClaimOwnershipError(resource);
    }

    const fenceRow = tx
      .select()
      .from(schema.fences)
      .where(eq(schema.fences.resource, canonicalResource))
      .get();

    if (!fenceRow) {
      return; // Nothing to release -- idempotent
    }

    assertFence(fenceRow.current_fence, fence);

    tx.delete(schema.claims)
      .where(eq(schema.claims.resource, canonicalResource))
      .run();

    appendJournal(tx, {
      kind: "claim.released",
      resource: canonicalResource,
      actor: origin.actor,
      fence,
      tokenId: origin.tokenId,
      source: origin.source,
      sourceVersion: origin.sourceVersion,
    });
  });
}

export function state(
  db: BaseSQLiteDatabase<"sync", unknown, typeof schema>,
  resource: string,
  now: number = Date.now(),
): Claim | null {
  const canonicalResource = resolveEntityResource(db, resource) ?? resource;
  const row = db
    .select()
    .from(schema.claims)
    .where(eq(schema.claims.resource, canonicalResource))
    .get();

  if (!row) return null;

  if (row.expires_at <= now) return null;

  return {
    resource: row.resource,
    machine: row.machine,
    user: row.user,
    mode: row.mode as "exclusive" | "owner" | "presence",
    fence: row.fence,
    acquired_at: row.acquired_at,
    expires_at: row.expires_at,
    metadata: JSON.parse(row.metadata ?? "{}") as Record<string, unknown>,
  };
}

export function listClaims(
  db: BaseSQLiteDatabase<"sync", unknown, typeof schema>,
  now: number = Date.now(),
): Claim[] {
  const rows = db
    .select()
    .from(schema.claims)
    .where(gt(schema.claims.expires_at, now))
    .all();
  return rows.map((row) => ({
    resource: row.resource,
    machine: row.machine,
    user: row.user,
    mode: row.mode as "exclusive" | "owner" | "presence",
    fence: row.fence,
    acquired_at: row.acquired_at,
    expires_at: row.expires_at,
    metadata: JSON.parse(row.metadata ?? "{}") as Record<string, unknown>,
  }));
}

/**
 * Count claims whose expires_at is in the past.
 * These are claims the sweep has not yet reaped.
 */
export function countExpiredClaims(
  db: BaseSQLiteDatabase<"sync", unknown, typeof schema>,
  now: number = Date.now(),
): number {
  const row = db
    .select({ count: sql<number>`count(*)` })
    .from(schema.claims)
    .where(lte(schema.claims.expires_at, now))
    .get();
  return row?.count ?? 0;
}

export function heartbeat(
  db: BaseSQLiteDatabase<"sync", unknown, typeof schema>,
  machine: string,
  info?: Record<string, unknown>,
  now: number = Date.now(),
): void {
  db.run(
    sql`INSERT OR REPLACE INTO presence(machine, last_seen, info) VALUES(${machine}, ${now}, ${JSON.stringify(info ?? {})})`,
  );
}

export function listPresence(
  db: BaseSQLiteDatabase<"sync", unknown, typeof schema>,
  ttlMs = 60_000,
  now: number = Date.now(),
): Presence[] {
  const cutoff = now - ttlMs;
  const rows = db
    .select()
    .from(schema.presence)
    .where(gt(schema.presence.last_seen, cutoff))
    .all();

  return rows.map((row) => ({
    machine: row.machine,
    last_seen: row.last_seen,
    info: JSON.parse(row.info) as Record<string, unknown>,
  }));
}

export interface PresenceWithStatus extends Presence {
  active: boolean;
}

export function listAllPresence(
  db: BaseSQLiteDatabase<"sync", unknown, typeof schema>,
  ttlMs = 60_000,
  now: number = Date.now(),
): PresenceWithStatus[] {
  const cutoff = now - ttlMs;
  const rows = db
    .select()
    .from(schema.presence)
    .where(gt(schema.presence.last_seen, cutoff))
    .all();
  return rows.map((row) => ({
    machine: row.machine,
    last_seen: row.last_seen,
    info: JSON.parse(row.info) as Record<string, unknown>,
    active: row.last_seen > cutoff,
  }));
}
