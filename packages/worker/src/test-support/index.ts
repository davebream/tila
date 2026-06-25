/**
 * @tila/worker/test-support
 *
 * Shared auth test harness for integration tests and sibling WI builders.
 * All exports are test-scope only — never importable by production worker code.
 *
 * Usage pattern in each consuming test file:
 *
 *   import {
 *     backendD1MockFactory,
 *     resetBackendD1Mocks,
 *     makeAuthEnv,
 *     createAuthTestApp,
 *     authFixtures,
 *     featurePending,
 *     _resetMiddlewareStateForTest,
 *     revokeJtiInCache,
 *   } from "@tila/worker/test-support";
 *
 *   // Per-file hoisted mock (vitest hoisting is per-module — unavoidable):
 *   vi.mock("@tila/backend-d1", () => backendD1MockFactory());
 *
 *   beforeEach(() => {
 *     _resetMiddlewareStateForTest();
 *     resetBackendD1Mocks();
 *   });
 */

// Middleware and testing helpers re-exported from worker source
export {
  createAuthMiddleware,
  _resetMiddlewareStateForTest,
  revokeJtiInCache,
} from "../middleware/auth";

// Mock factory + handles + reset
export {
  backendD1MockFactory,
  resetBackendD1Mocks,
  mockSessionValidate,
  mockSessionCreate,
  mockRevokedJtiIsRevoked,
  mockRevokedJtiRevoke,
  mockTokenValidate,
  mockTokenUpdateLastUsedAt,
  mockRateLimitCheck,
  mockRateLimitRecordFailure,
  mockIdempotencyCheck,
  mockIdempotencyStore,
  mockRepoListForProject,
  mockRepoIsRegistered,
  mockGitHubAppConfigSetInstallation,
  mockGitHubAppConfigGetInstallation,
} from "./backend-d1-mock";

// Env builder + test HMAC key
export { makeAuthEnv, TEST_HMAC_KEY } from "./env";

// Hono test app factory
export { createAuthTestApp } from "./app";

// Credential builders and deferred stubs
export {
  authFixtures,
  mintSessionToken,
  mintD1Token,
  hashToken,
  mintOidcJwt,
  buildDpopProof,
  instanceBinding,
} from "./fixtures";

// Skip-gating wrapper
export { featurePending } from "./feature-pending";
