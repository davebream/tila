/**
 * C6: Typed Worker↔DO seam contract.
 *
 * Provides:
 *   - `DO_PATHS` — a const registry of every DO path forwarded by the Worker
 *     routes. Path typing via `DoPath` is the compile-time safety win: a typo
 *     or renamed path fails tsc rather than silently routing to 404.
 *   - `DoPath` — union of the registered path strings (for function signatures).
 *   - `forwardTypedDO<T>` — thin wrapper over `forwardToDO` that centralises
 *     the `as T` response assertion into one auditable location. The `<T>` is
 *     a compile-time assertion only (no runtime Zod validation), consistent
 *     with the design decision to avoid hot-path overhead on an already
 *     type-safe internal seam.
 *
 * forwardToDO is intentionally left unchanged — this module adds a typed layer
 * on top without modifying the underlying HTTP forwarding implementation.
 */

import type { analyticsCtxFrom } from "./analytics";
import { forwardToDO } from "./do-forward";

// ---------------------------------------------------------------------------
// Path registry — all DO paths forwarded by the Worker routes.
// ---------------------------------------------------------------------------

export const DO_PATHS = {
  // Schema routes
  schemaCurrent: "/schema/current",
  schemaApply: "/schema/apply",
  schemaPreview: "/schema/preview",

  // Artifact routes
  artifactPointer: "/artifact/pointer",
  artifactPointers: "/artifact/pointers",
  artifactPointerMeta: "/artifact/pointer-meta",
  artifactList: "/artifact/list",
  artifactLatest: "/artifact/latest",
  artifactSearch: "/artifact/search",
  artifactGrepCandidates: "/artifact/grep-candidates",
  artifactSearchablePointers: "/artifact/searchable-pointers",
  artifactSearchRebuildScan: "/artifact/search-rebuild-scan",
  artifactSearchRebuild: "/artifact/search-rebuild",
  artifactReconcile: "/artifact/reconcile",
  artifactTombstone: "/artifact/tombstone",
  artifactRelationship: "/artifact/relationship",
  artifactRelationships: "/artifact/relationships",
  artifactIndexEntries: "/artifact/index/entries",
  artifactSearchDrift: "/artifact/search-drift",

  // Record routes
  recordTypesInUse: "/record/types-in-use",

  // Entity routes
  entityCreate: "/entity/create",
  entityArtifactRef: "/entity/artifact-ref",

  // Coordination routes
  coordAcquire: "/coord/acquire",
  coordRelease: "/coord/release",
  coordHealth: "/coord/health",

  // Doctor / diagnostic routes
  doctorSchema: "/doctor/schema",
} as const;

/** Union of all registered DO path strings. */
export type DoPath = (typeof DO_PATHS)[keyof typeof DO_PATHS];

// ---------------------------------------------------------------------------
// forwardTypedDO — typed wrapper over forwardToDO
// ---------------------------------------------------------------------------

/**
 * Forward a request to the DO and return the parsed JSON body as `T`.
 *
 * The `<T>` type parameter is a centralized compile-time assertion — it
 * replaces the scattered `(await res.json()) as {...}` casts in route files
 * with a single auditable assertion point. Runtime validation is opt-in
 * (pass a Zod schema) but not the default, per the design decision to avoid
 * hot-path overhead on the internal DO seam.
 *
 * The caller is responsible for checking `response.ok` before trusting the
 * parsed body — `forwardTypedDO` throws/propagates the same errors as
 * `forwardToDO`.
 */
export async function forwardTypedDO<T>(
  stub: DurableObjectStub,
  path: DoPath,
  method: string,
  body?: unknown,
  query?: Record<string, string>,
  analyticsCtx?: ReturnType<typeof analyticsCtxFrom>,
  extraHeaders?: Record<string, string>,
): Promise<{ response: Response; json: T }> {
  const response = await forwardToDO(
    stub,
    path,
    method,
    body,
    query,
    analyticsCtx,
    extraHeaders,
  );
  const json = (await response.json()) as T;
  return { response, json };
}
