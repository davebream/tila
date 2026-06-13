import { assertFence } from "@tila/core";
import { eq } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import * as schema from "./schema";

export class FenceNotFoundError extends Error {
  public readonly code = "no-fence";

  constructor(resource: string) {
    super(
      `No fence row for resource ${resource} -- claim must be acquired before using a fence`,
    );
    this.name = "FenceNotFoundError";
  }
}

export class ClaimOwnershipError extends Error {
  constructor(resource: string) {
    super(`Only the current holder may release claim ${resource}`);
    this.name = "ClaimOwnershipError";
  }
}

/**
 * Thrown when a required-fence destructive write targets an entity resource
 * whose claim has expired or been released. The fence number alone can still
 * match `current_fence` (entity fences do not bump on write), so without this
 * check an expired-lease late write — a "zombie write" — would be silently
 * accepted. Maps to HTTP 409 `stale-fence`: the caller must re-acquire.
 */
export class ExpiredClaimError extends Error {
  constructor(resource: string) {
    super(
      `No live claim for resource ${resource} -- the lease has expired or been released; re-acquire before writing`,
    );
    this.name = "ExpiredClaimError";
  }
}

/**
 * Resolve the canonical `<type>:<id>` resource string for an entity.
 *
 * Performs an entity-existence lookup (not a separator heuristic) to handle
 * the two input forms:
 *   - Bare entity id (e.g. `"abc-123"`) → looks up entity, returns `"task:abc-123"`.
 *   - Already-canonical typed form (e.g. `"task:abc-123"`) → extracts the id part,
 *     confirms it exists in entities with the expected type, returns as-is.
 *
 * Returns `null` when the resource is not an entity (records, arbitrary coordination
 * resources, etc.) — callers fall through to their own exact-match path.
 *
 * This is the single disambiguation point for the entity resource convention.
 * All code that constructs or validates entity claim/fence resources should
 * go through this helper rather than rolling its own colon/slash heuristic.
 */
export function resolveEntityResource(
  db: BaseSQLiteDatabase<"sync", unknown, typeof schema>,
  resource: string,
): string | null {
  // Case 1: bare entity id — resource itself exists in entities
  const bareEntity = db
    .select({ type: schema.entities.type })
    .from(schema.entities)
    .where(eq(schema.entities.id, resource))
    .get();

  if (bareEntity) {
    return `${bareEntity.type}:${resource}`;
  }

  // Case 2: typed entity resource `<type>:<id>` — extract the id suffix and
  // verify it exists in entities with the declared type prefix.
  const colonIdx = resource.indexOf(":");
  if (colonIdx > 0) {
    const possibleId = resource.slice(colonIdx + 1);
    const typedEntity = db
      .select({ type: schema.entities.type })
      .from(schema.entities)
      .where(eq(schema.entities.id, possibleId))
      .get();

    if (typedEntity && `${typedEntity.type}:${possibleId}` === resource) {
      return resource; // already canonical
    }
  }

  // Not an entity resource — record resources, arbitrary coordination keys, etc.
  return null;
}

/**
 * Look up a fence row by exact resource key.
 * Returns the fence row or undefined if absent.
 */
function lookupFence(
  db: BaseSQLiteDatabase<"sync", unknown, typeof schema>,
  resource: string,
) {
  return db
    .select()
    .from(schema.fences)
    .where(eq(schema.fences.resource, resource))
    .get();
}

/**
 * Look up the (single) claim row for a canonical resource, or undefined.
 */
function lookupClaim(
  db: BaseSQLiteDatabase<"sync", unknown, typeof schema>,
  resource: string,
) {
  return db
    .select()
    .from(schema.claims)
    .where(eq(schema.claims.resource, resource))
    .get();
}

/**
 * Validate a fence for a resource.
 *
 * Canonical entity claim+fence resource is `<type>:<id>`. Disambiguation is
 * by entity-existence lookup via `resolveEntityResource`, never by separator
 * characters (record resources are `record:<type>/<key>` and contain a colon,
 * so a colon/slash heuristic would misclassify them).
 *
 * Resolution order:
 *   1. Entity-existence check: if `resource` names a known entity (bare id or
 *      canonical typed form), resolve the fence against the canonical `<type>:<id>`
 *      row. Both bare-id and typed callers converge on the same row.
 *   2. Exact-match fallback: for non-entity resources (records, arbitrary
 *      coordination keys) look up the fence row directly.
 */
export interface AssertResourceFenceOptions {
  /** Clock for claim-liveness evaluation (injectable for tests). */
  now?: number;
  /**
   * When true, an entity-resource write additionally requires a LIVE claim
   * (not just a matching fence). Entity fences are claim-based and do not bump
   * on write, so a stale fence can still equal `current_fence` after a lease
   * expires with no competing re-acquire — the zombie-write window. Callers on
   * the entity destructive-write path (entity update/archive) pass true to
   * close it. Defaults to false to preserve the fence-only contract for the
   * other fenced paths (records use fence-bump CAS; gate/artifact liveness is
   * tracked as a follow-up).
   */
  requireLiveClaim?: boolean;
}

export function assertResourceFence(
  db: BaseSQLiteDatabase<"sync", unknown, typeof schema>,
  resource: string,
  fence: number,
  opts: AssertResourceFenceOptions = {},
): void {
  const { now = Date.now(), requireLiveClaim = false } = opts;
  const canonical = resolveEntityResource(db, resource);

  if (canonical !== null) {
    // Entity resource path: canonical typed row only.
    const canonicalFence = lookupFence(db, canonical);
    if (!canonicalFence) {
      throw new FenceNotFoundError(resource);
    }
    assertFence(canonicalFence.current_fence, fence);

    if (requireLiveClaim) {
      const claim = lookupClaim(db, canonical);
      if (!claim || claim.expires_at <= now) {
        throw new ExpiredClaimError(resource);
      }
    }
    return;
  }

  // Non-entity resource — exact match only.
  const exactFence = lookupFence(db, resource);
  if (exactFence) {
    assertFence(exactFence.current_fence, fence);
    return;
  }

  throw new FenceNotFoundError(resource);
}
