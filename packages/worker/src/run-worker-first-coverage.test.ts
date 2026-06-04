/**
 * run-worker-first coverage guard.
 *
 * Asserts that every top-level route prefix registered in the Worker is
 * present in RUN_WORKER_FIRST (imported from @tila/schemas, the single
 * source of truth). This guards against a future route prefix being added
 * without updating the run_worker_first list, which would cause Static
 * Assets to serve index.html instead of routing to the Worker.
 *
 * A missed prefix = OAuth callback or API path served index.html = silent
 * auth breakage.
 *
 * Approach: introspect the live Hono app (imported from ./index.ts).
 * app.routes returns a flat array of { method, path } for every registered
 * handler. We extract the distinct top-level path segments and assert each
 * is covered by a RUN_WORKER_FIRST entry.
 *
 * This goes RED automatically when a developer adds a new top-level mount
 * (e.g. app.route("/webhooks", ...)) without updating RUN_WORKER_FIRST.
 */

import { RUN_WORKER_FIRST } from "@tila/schemas";
import { describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock heavy dependencies that are not needed for route introspection.
// These are the same bindings the Worker imports at module load time.
// ---------------------------------------------------------------------------
vi.mock("@tila/backend-d1", () => ({
  D1ProjectRegistry: vi.fn(),
  D1SessionStore: vi.fn().mockImplementation(
    class {
      validate = vi.fn();
      deleteExpired = vi.fn().mockResolvedValue({ deleted: 0 });
    } as unknown as () => unknown,
  ),
  D1RateLimitStore: vi.fn().mockImplementation(
    class {
      check = vi.fn().mockResolvedValue(false);
      recordFailure = vi.fn().mockResolvedValue(undefined);
    } as unknown as () => unknown,
  ),
  D1TokenStore: vi.fn().mockImplementation(
    class {
      validate = vi.fn().mockResolvedValue(null);
      updateLastUsedAt = vi.fn().mockResolvedValue(undefined);
    } as unknown as () => unknown,
  ),
}));

vi.mock("@tila/backend-r2", () => ({
  R2ArtifactBackend: vi.fn(),
}));

vi.mock("@tila/backend-do", () => ({
  ProjectDO: vi.fn(),
}));

vi.mock("./lib/session-cache", () => ({
  getSessionFromCache: vi.fn().mockReturnValue(undefined),
  setSessionInCache: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Import the live Hono app for introspection.
// The mocks above allow the module to load without real Cloudflare bindings.
// ---------------------------------------------------------------------------
import { app } from "./index";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract the distinct top-level path segment from a registered route path.
 *
 * Examples:
 *   "/api/tokens"          → "/api"
 *   "/auth/github/login"   → "/auth"
 *   "/projects/:projectId" → "/projects"
 *   "/_internal/sweep"     → "/_internal"
 *   "/"                    → "/" (asset-served root, excluded below)
 *   "*"                    → "*" (wildcard middleware, excluded below)
 *
 * Returns null for paths that are the bare root or pure wildcards.
 */
function extractTopLevelSegment(routePath: string): string | null {
  // Normalise: trim trailing slashes except bare "/"
  const p = routePath === "/" ? "/" : routePath.replace(/\/$/, "");

  // Split on "/" — e.g. "/api/tokens" → ["", "api", "tokens"]
  const parts = p.split("/");

  // parts[0] is always "" (before the leading "/"), parts[1] is the segment
  const segment = parts[1];

  if (!segment || segment === "*") {
    // Bare root or wildcard middleware — asset-served, not a server prefix
    return null;
  }

  return `/${segment}`;
}

/**
 * Given a top-level segment (e.g. "/api"), return whether it is covered by
 * any entry in RUN_WORKER_FIRST.
 *
 * RUN_WORKER_FIRST entries use glob syntax: "/api/*" covers "/api".
 */
function isCoveredByRunWorkerFirst(segment: string): boolean {
  return RUN_WORKER_FIRST.some((pattern) => {
    // "/api/*" covers "/api" — strip the "/*" suffix and compare
    const base = pattern.endsWith("/*") ? pattern.slice(0, -2) : pattern;
    return segment === base;
  });
}

// ---------------------------------------------------------------------------
// Guard test
// ---------------------------------------------------------------------------

describe("run_worker_first coverage guard", () => {
  it("every top-level Worker route prefix is covered by RUN_WORKER_FIRST", () => {
    // Walk all routes registered in the live Hono app
    const routes = app.routes as Array<{ method: string; path: string }>;

    // Collect distinct top-level segments (skip null = root/wildcard)
    const topLevelSegments = new Set<string>();
    for (const { path } of routes) {
      const segment = extractTopLevelSegment(path);
      if (segment !== null) {
        topLevelSegments.add(segment);
      }
    }

    expect(topLevelSegments.size).toBeGreaterThan(0); // sanity: app must have routes

    // Assert every discovered prefix is covered
    const uncoveredPrefixes: string[] = [];
    for (const segment of topLevelSegments) {
      if (!isCoveredByRunWorkerFirst(segment)) {
        uncoveredPrefixes.push(segment);
      }
    }

    expect(
      uncoveredPrefixes,
      `The following top-level Worker route prefixes are NOT covered by RUN_WORKER_FIRST in @tila/schemas:\n  ${uncoveredPrefixes.join(", ")}\n\nWithout a matching entry, Static Assets will serve index.html for browser navigations to these paths.\nFix: add the missing prefix(es) to packages/schemas/src/deploy-routes.ts.`,
    ).toHaveLength(0);
  });

  it("RUN_WORKER_FIRST entries all have matching routes in the app (no orphaned entries)", () => {
    // Walk all routes registered in the live Hono app
    const routes = app.routes as Array<{ method: string; path: string }>;

    const topLevelSegments = new Set<string>();
    for (const { path } of routes) {
      const segment = extractTopLevelSegment(path);
      if (segment !== null) {
        topLevelSegments.add(segment);
      }
    }

    // Every RUN_WORKER_FIRST entry should correspond to a real route
    const orphanedEntries: string[] = [];
    for (const pattern of RUN_WORKER_FIRST) {
      const base = pattern.endsWith("/*") ? pattern.slice(0, -2) : pattern;
      if (!topLevelSegments.has(base)) {
        orphanedEntries.push(pattern);
      }
    }

    expect(
      orphanedEntries,
      `The following RUN_WORKER_FIRST entries have no matching routes in the Worker app:\n  ${orphanedEntries.join(", ")}\n\nThese entries are stale. Remove them from packages/schemas/src/deploy-routes.ts.`,
    ).toHaveLength(0);
  });
});
