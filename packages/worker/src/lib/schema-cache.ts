/**
 * Per-isolate schema cache (C2 / AC-1).
 *
 * Wraps an LruTtlCache (30s positive TTL) keyed by project id.
 * A "no schema configured" result is cached as a positive null entry (same TTL)
 * so unconfigured projects avoid a per-write DO round-trip.
 *
 * A failed DO fetch (network / 5xx) is NOT cached — it propagates as-is and
 * the next call retries.
 *
 * Cross-isolate staleness of up to 30s after a schema mutation is explicitly
 * accepted (see design doc C2 invalidation contract).
 */
import { LruTtlCache } from "./lru-ttl-cache";

/** Shape of the schema object returned by the DO /schema/current response. */
export interface SchemaBody {
  definition: string;
}

/**
 * Cached value: the schema object or null (no schema configured).
 * undefined means "not in cache" (internal LruTtlCache sentinel).
 */
type CachedSchema = SchemaBody | null;

const SCHEMA_TTL_MS = 30_000; // 30s positive TTL

const cache = new LruTtlCache<CachedSchema>({
  maxSize: 500, // one entry per project; 500 projects per isolate is generous
  positiveTtlMs: SCHEMA_TTL_MS,
  negativeTtlMs: SCHEMA_TTL_MS, // same TTL for null (no-schema) entries
});

/**
 * Return the current schema for a project, using the per-isolate cache.
 *
 * On a cache miss, fetches from the DO via GET /schema/current. Caches the
 * result (including null for "no schema configured"). Throws on DO errors so
 * callers can surface them — failed fetches are NOT cached.
 */
export async function getCurrentSchema(
  stub: DurableObjectStub,
  projectId: string,
): Promise<SchemaBody | null> {
  const cached = cache.get(projectId);
  // LruTtlCache.get() returns undefined on miss/expired, so we distinguish
  // "value was cached (including null)" from "not in cache".
  if (cached !== undefined) {
    return cached;
  }

  // Cache miss — fetch from DO.
  const url = new URL("https://do/schema/current");
  const res = await stub.fetch(new Request(url, { method: "GET" }));

  if (!res.ok) {
    // DO returned an error status — do NOT cache; propagate to caller.
    const body = await res.text();
    throw new Error(`DO /schema/current returned ${res.status}: ${body}`);
  }

  const body = (await res.json()) as {
    ok: boolean;
    schema: SchemaBody | null;
    version: number | null;
  };

  // Cache the result (null if no schema configured — positive TTL applies).
  // We use negative=false for both cases: null is a valid "no schema" positive
  // result, not a "negative" cache entry in the LruTtlCache sense.
  const schema = body.schema ?? null;
  cache.set(projectId, schema, false);

  return schema;
}

/**
 * Invalidate the schema cache entry for a project.
 * Call this on the successful-write path of any schema mutation handler
 * (both CREATE and UPDATE via POST /schema/apply).
 */
export function bustSchemaCache(projectId: string): void {
  cache.delete(projectId);
}

/** For testing only — resets all module-level state. */
export function _clearSchemaCacheForTest(): void {
  cache.clear();
}

/** For testing only — returns current cache size. */
export function _schemaCacheSizeForTest(): number {
  return cache.size;
}
