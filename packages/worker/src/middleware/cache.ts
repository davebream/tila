import type { MiddlewareHandler } from "hono";

type VolatilityTier = "low" | "medium" | "high" | "skip";

/** TTL in seconds per tier (used in Cache API stored responses) */
const TTL: Record<Exclude<VolatilityTier, "skip">, number> = {
  low: 5,
  medium: 2,
  high: 1,
};

/** Cache-Control header value for browser-facing responses per tier */
const CACHE_CONTROL: Record<Exclude<VolatilityTier, "skip">, string> = {
  low: "private, max-age=3, stale-while-revalidate=5",
  medium: "private, max-age=1, stale-while-revalidate=2",
  high: "private, max-age=1, stale-while-revalidate=1",
};

/** Map of first path segment to volatility tier */
const TIER_MAP: Record<string, VolatilityTier> = {
  tasks: "low",
  entities: "low",
  "work-units": "low",
  records: "low",
  schema: "low",
  templates: "low",
  summary: "low",
  artifacts: "low",
  search: "low",
  gates: "low",
  claims: "medium",
  journal: "medium",
  signals: "medium",
  presence: "high",
  admin: "skip",
  doctor: "skip",
};

/**
 * Classify a route path to a volatility tier.
 * Extracts the first non-empty path segment and looks it up in TIER_MAP.
 * Defaults to "skip" for unrecognized segments.
 */
export function classifyRoute(path: string): VolatilityTier {
  const segments = path.split("/").filter(Boolean);
  if (segments.length === 0) return "skip";
  return TIER_MAP[segments[0]] ?? "skip";
}

/**
 * Build a synthetic Request for use as a Cache API key.
 * Format: https://cache.tila/<projectId><path>?<sorted-query-params>
 * Query parameters are sorted alphabetically to normalize key.
 */
export function buildCacheKey(
  projectId: string,
  path: string,
  queryString: string,
): Request {
  const params = new URLSearchParams(queryString);
  // Sort params alphabetically by key
  const sorted = new URLSearchParams(
    [...params.entries()].sort(([a], [b]) => a.localeCompare(b)),
  );
  const qs = sorted.toString();
  const url = `https://cache.tila/${projectId}${path}${qs ? `?${qs}` : ""}`;
  return new Request(url);
}

/**
 * Invalidation map: for each written segment, which segments to invalidate.
 */
const INVALIDATION_MAP: Record<string, string[]> = {
  tasks: ["tasks", "summary", "search"],
  entities: ["tasks", "summary", "search"],
  "work-units": ["tasks", "summary", "search"],
  claims: ["claims"],
  records: ["records"],
  artifacts: ["artifacts", "search"],
  journal: ["journal"],
  presence: ["presence"],
  signals: ["signals"],
  schema: ["schema"],
  gates: ["gates"],
  templates: ["templates"],
};

/**
 * Invalidate cached entries for the written segment and related segments.
 * Failures are logged but not propagated.
 */
export async function invalidateProjectCache(
  cache: Cache,
  projectId: string,
  writtenSegment: string,
): Promise<void> {
  const segments = INVALIDATION_MAP[writtenSegment] ?? [writtenSegment];
  for (const segment of segments) {
    const key = buildCacheKey(projectId, `/${segment}`, "");
    try {
      await cache.delete(key);
    } catch (err) {
      console.warn(`[cache] failed to delete cache key for /${segment}:`, err);
    }
  }
}

/**
 * Extract the first path segment from a URL path.
 */
function extractFirstSegment(urlPath: string): string {
  const segments = urlPath.split("/").filter(Boolean);
  return segments[0] ?? "";
}

/**
 * Add Cache-Control header to a response, returning a new Response.
 */
function withCacheControl(res: Response, value: string): Response {
  const newHeaders = new Headers(res.headers);
  newHeaders.set("Cache-Control", value);
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers: newHeaders,
  });
}

/**
 * Hono middleware factory for Cloudflare Workers Cache API caching.
 *
 * - GET requests: check cache, serve hit or fetch from DO then cache the response.
 * - POST/PATCH/DELETE: let the write proceed, then invalidate related cache entries.
 * - All cache operations are best-effort: errors are logged and never propagated.
 * - Gracefully degrades (pass-through) when Cache API is unavailable (wrangler dev).
 */
export function createCacheMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    const method = c.req.method;
    const reqUrl = new URL(c.req.url);
    const urlPath = reqUrl.pathname;
    const tier = classifyRoute(urlPath);

    // Detect Cache API availability at request time
    const cacheApi =
      typeof caches !== "undefined" &&
      caches !== null &&
      typeof (caches as unknown as { default?: unknown }).default !==
        "undefined"
        ? (caches as unknown as { default: Cache }).default
        : null;

    if (method === "GET") {
      // skip tier: pass through, no Cache-Control added
      if (tier === "skip") {
        return next();
      }

      const cacheControl = CACHE_CONTROL[tier];

      // Cache API unavailable: pass through, add Cache-Control header
      if (!cacheApi) {
        await next();
        c.res = withCacheControl(c.res, cacheControl);
        return;
      }

      // Cache API available: try to serve from cache
      const projectId = c.get("projectId") as string;
      const cacheKey = buildCacheKey(
        projectId,
        urlPath,
        reqUrl.search.slice(1),
      );

      let cached: Response | undefined;
      try {
        cached = await cacheApi.match(cacheKey);
      } catch (err) {
        console.warn("[cache] match failed, falling through to origin:", err);
      }

      if (cached) {
        // Cache hit: return cached response directly
        return c.newResponse(cached.body, cached);
      }

      // Cache miss: proceed to origin
      await next();

      // Store response in cache via waitUntil (non-blocking)
      try {
        const ttl = TTL[tier];
        const responseToStore = c.res.clone();
        const storedHeaders = new Headers(responseToStore.headers);
        storedHeaders.set("Cache-Control", `public, max-age=${ttl}`);
        const storedResponse = new Response(responseToStore.body, {
          status: responseToStore.status,
          statusText: responseToStore.statusText,
          headers: storedHeaders,
        });
        const putPromise = cacheApi.put(cacheKey, storedResponse);
        try {
          c.executionCtx.waitUntil(putPromise);
        } catch {
          // ExecutionContext not available (e.g. unit tests) — await directly
          await putPromise;
        }
      } catch (err) {
        console.warn("[cache] put failed:", err);
      }

      // Add private Cache-Control to browser-facing response
      c.res = withCacheControl(c.res, cacheControl);
      return;
    }

    // Non-GET: pass through, then invalidate on successful writes
    await next();

    if (
      cacheApi &&
      (method === "POST" || method === "PATCH" || method === "DELETE") &&
      c.res.ok
    ) {
      const segment = extractFirstSegment(urlPath);
      const projectId = c.get("projectId") as string;
      const invalidatePromise = invalidateProjectCache(
        cacheApi,
        projectId,
        segment,
      );
      try {
        c.executionCtx.waitUntil(invalidatePromise);
      } catch {
        // ExecutionContext not available (e.g. unit tests) — await directly
        await invalidatePromise;
      }
    }
  };
}
