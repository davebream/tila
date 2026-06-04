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
 *      Fallback to a bare-id fence row when the canonical typed row is absent
 *      (pre-migration window — harmless after migration 17 runs).
 *   2. Exact-match fallback: for non-entity resources (records, arbitrary
 *      coordination keys) look up the fence row directly.
 */
export function assertResourceFence(
  db: BaseSQLiteDatabase<"sync", unknown, typeof schema>,
  resource: string,
  fence: number,
): void {
  const canonical = resolveEntityResource(db, resource);

  if (canonical !== null) {
    // Entity resource path: always prefer the canonical typed row.
    const canonicalFence = lookupFence(db, canonical);
    if (canonicalFence) {
      assertFence(canonicalFence.current_fence, fence);
      return;
    }

    // Canonical typed row absent — fall back to bare-id row if present.
    // This path exists only during the window between a bare-id acquire and
    // the first migration-17 run. After migration 17, all bare-id fence rows
    // are promoted to typed rows and this fallback is a no-op.
    if (canonical !== resource) {
      // resource was a bare id; check bare-id fence row
      const bareFence = lookupFence(db, resource);
      if (bareFence) {
        assertFence(bareFence.current_fence, fence);
        return;
      }
    }

    throw new FenceNotFoundError(resource);
  }

  // Non-entity resource — exact match only.
  const exactFence = lookupFence(db, resource);
  if (exactFence) {
    assertFence(exactFence.current_fence, fence);
    return;
  }

  throw new FenceNotFoundError(resource);
}
