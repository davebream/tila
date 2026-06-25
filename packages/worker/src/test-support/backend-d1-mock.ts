/**
 * Shared backend-d1 mock factory for auth integration tests.
 *
 * Each consuming test file declares its own hoisted vi.mock call:
 *   vi.mock("@tila/backend-d1", () => backendD1MockFactory())
 *
 * The factory covers the FULL store surface that the mounted auth routes
 * construct — reconciled against routes/auth-github.test.ts:59-95 and
 * middleware/auth.ts (D1RevokedJtiStore at :599).
 *
 * Mutable handles are exposed for per-test behavior overrides.
 * Call resetBackendD1Mocks() in beforeEach to restore defaults.
 *
 * NOTE: vitest vi.fn() instances cannot be shared across module boundaries
 * as live "hoisted" mocks — each test file's vi.mock declaration captures the
 * factory at hoist time. The handles below are module-level and shared within
 * a single test file via the factory's class closures. When the consumer file
 * imports handles from this module, they reference the same vi.fn() instances.
 */
import { type Mock, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mutable mock handles — consumers import these to override per-test behavior
// ---------------------------------------------------------------------------

/** D1SessionStore.validate — return a SessionResult or null */
export const mockSessionValidate: Mock = vi.fn().mockResolvedValue(null);

/** D1SessionStore.create — for session-creation routes */
export const mockSessionCreate: Mock = vi.fn().mockResolvedValue(undefined);

/** D1RevokedJtiStore.isRevoked — return true to simulate a revoked jti */
export const mockRevokedJtiIsRevoked: Mock = vi.fn().mockResolvedValue(false);

/** D1RevokedJtiStore.revoke */
export const mockRevokedJtiRevoke: Mock = vi.fn().mockResolvedValue(undefined);

/** D1TokenStore.validate — return a TokenResult or null */
export const mockTokenValidate: Mock = vi.fn().mockResolvedValue(null);

/** D1TokenStore.updateLastUsedAt */
export const mockTokenUpdateLastUsedAt: Mock = vi
  .fn()
  .mockResolvedValue(undefined);

/** D1RateLimitStore.check — return true to trigger rate-limiting */
export const mockRateLimitCheck: Mock = vi.fn().mockResolvedValue(false);

/** D1RateLimitStore.recordFailure */
export const mockRateLimitRecordFailure: Mock = vi
  .fn()
  .mockResolvedValue(undefined);

/** D1IdempotencyStore.check */
export const mockIdempotencyCheck: Mock = vi.fn().mockResolvedValue(null);

/** D1IdempotencyStore.store */
export const mockIdempotencyStore: Mock = vi.fn().mockResolvedValue(undefined);

/** RepoAllowlistStore.listForProject */
export const mockRepoListForProject: Mock = vi.fn().mockResolvedValue([]);

/** RepoAllowlistStore.isRegistered */
export const mockRepoIsRegistered: Mock = vi.fn().mockResolvedValue(null);

/** GitHubAppConfigStore.setInstallation */
export const mockGitHubAppConfigSetInstallation: Mock = vi
  .fn()
  .mockResolvedValue(undefined);

/** GitHubAppConfigStore.getInstallation */
export const mockGitHubAppConfigGetInstallation: Mock = vi
  .fn()
  .mockResolvedValue(null);

// ---------------------------------------------------------------------------
// Factory function — passed as the second argument to vi.mock()
// ---------------------------------------------------------------------------

/**
 * Returns a module-level mock for "@tila/backend-d1" covering all stores
 * the auth routes construct. Pass to vi.mock() in each consuming test file:
 *
 *   import { backendD1MockFactory } from "@tila/worker/test-support";
 *   vi.mock("@tila/backend-d1", () => backendD1MockFactory());
 *
 * vitest 4 forbids arrow-function implementations as constructors; `class`
 * expressions are constructable. The `as unknown as () => unknown` cast
 * satisfies mockImplementation's call-signature constraint. Do NOT simplify
 * these back to arrow functions.
 */
export function backendD1MockFactory(): Record<string, unknown> {
  return {
    D1SessionStore: vi.fn().mockImplementation(
      class {
        validate = mockSessionValidate;
        create = mockSessionCreate;
      } as unknown as () => unknown,
    ),
    D1RevokedJtiStore: vi.fn().mockImplementation(
      class {
        isRevoked = mockRevokedJtiIsRevoked;
        revoke = mockRevokedJtiRevoke;
      } as unknown as () => unknown,
    ),
    D1TokenStore: vi.fn().mockImplementation(
      class {
        validate = mockTokenValidate;
        updateLastUsedAt = mockTokenUpdateLastUsedAt;
      } as unknown as () => unknown,
    ),
    D1RateLimitStore: vi.fn().mockImplementation(
      class {
        check = mockRateLimitCheck;
        recordFailure = mockRateLimitRecordFailure;
      } as unknown as () => unknown,
    ),
    D1IdempotencyStore: vi.fn().mockImplementation(
      class {
        check = mockIdempotencyCheck;
        store = mockIdempotencyStore;
      } as unknown as () => unknown,
    ),
    RepoAllowlistStore: vi.fn().mockImplementation(
      class {
        listForProject = mockRepoListForProject;
        isRegistered = mockRepoIsRegistered;
      } as unknown as () => unknown,
    ),
    GitHubAppConfigStore: vi.fn().mockImplementation(
      class {
        setInstallation = mockGitHubAppConfigSetInstallation;
        getInstallation = mockGitHubAppConfigGetInstallation;
      } as unknown as () => unknown,
    ),
  };
}

/**
 * Configure D1RevokedJtiStore.isRevoked to return a specific value from within
 * the module scope, ensuring the delegating closure in the mock class reads the
 * correct fn after a reset (avoids ESM live-binding cross-package propagation issues).
 *
 * Call AFTER resetBackendD1Mocks() has run (e.g. in the test body after beforeEach).
 */
export function configureRevokedJtiIsRevoked(returnValue: boolean): void {
  mockRevokedJtiIsRevoked.mockResolvedValue(returnValue);
}

/**
 * Reset all mock handles to their default no-op implementations.
 * Call in beforeEach to prevent cross-test contamination.
 */
export function resetBackendD1Mocks(): void {
  mockSessionValidate.mockReset().mockResolvedValue(null);
  mockSessionCreate.mockReset().mockResolvedValue(undefined);
  // mockRevokedJtiIsRevoked is a stable const — same fn object across resets.
  // D1RevokedJtiStore.isRevoked is assigned directly to this fn (not a closure),
  // so instances always call this same fn object. Cross-package consumers that
  // import the handle always see the same fn object. Use configureRevokedJtiIsRevoked()
  // to set return value from outside this module.
  mockRevokedJtiIsRevoked.mockReset().mockResolvedValue(false);
  mockRevokedJtiRevoke.mockReset().mockResolvedValue(undefined);
  mockTokenValidate.mockReset().mockResolvedValue(null);
  mockTokenUpdateLastUsedAt.mockReset().mockResolvedValue(undefined);
  mockRateLimitCheck.mockReset().mockResolvedValue(false);
  mockRateLimitRecordFailure.mockReset().mockResolvedValue(undefined);
  mockIdempotencyCheck.mockReset().mockResolvedValue(null);
  mockIdempotencyStore.mockReset().mockResolvedValue(undefined);
  mockRepoListForProject.mockReset().mockResolvedValue([]);
  mockRepoIsRegistered.mockReset().mockResolvedValue(null);
  mockGitHubAppConfigSetInstallation.mockReset().mockResolvedValue(undefined);
  mockGitHubAppConfigGetInstallation.mockReset().mockResolvedValue(null);
}
