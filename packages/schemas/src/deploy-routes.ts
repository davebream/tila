/**
 * Route prefixes that must be handled by the Worker (not served as static assets).
 *
 * Used in the `[assets]` `run_worker_first` config field so that API routes,
 * auth callbacks, project routes, and internal sweep routes are routed to the
 * Worker even when `not_found_handling = "single-page-application"` is active.
 *
 * This constant is the single source of truth: consumed by:
 * - `packages/cli/src/lib/wrangler-config.ts` (config generator)
 * - `packages/worker` guard test (route-coverage assertion)
 *
 * Platform-agnostic — no Cloudflare Workers types imported.
 */
export const RUN_WORKER_FIRST = [
  "/api/*",
  "/auth/*",
  "/projects/*",
  "/_internal/*",
] as const;
