/**
 * @tila/worker/test-support
 *
 * Shared auth test harness for integration tests and sibling WI builders.
 * All exports are test-scope only — never importable by production worker code.
 *
 * Usage in each consuming test file:
 *   import { backendD1MockFactory, makeAuthEnv, ... } from "@tila/worker/test-support";
 *   vi.mock("@tila/backend-d1", () => backendD1MockFactory());
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
