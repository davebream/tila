/**
 * @tila/worker/test-support
 *
 * Shared auth test harness for integration tests and sibling WI builders.
 * All exports are test-scope only — never importable by production worker code.
 */

// Phase 1 skeleton: re-export auth middleware test-helpers
export {
  createAuthMiddleware,
  _resetMiddlewareStateForTest,
  revokeJtiInCache,
} from "../middleware/auth";
