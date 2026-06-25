/**
 * auth-instance-binding.test.ts — skip-gated pending tests for instance-binding auth.
 *
 * ALL cases in this file are skip-gated via featurePending. The production features
 * they test (WI-A instance-binding timestamp unification, WI-E cross-deployment
 * replay rejection) do not exist on main yet. Bodies reference the deferred
 * instanceBinding fixture stub which throws "shape TBD" — these throws are safe
 * because the tests are skipped before their bodies execute.
 *
 * Un-skip map:
 *   FEATURE-PENDING(WI-A, #123) → WI-A: timestamp ms-unification; off-by-1000 boundary gate
 *   FEATURE-PENDING(WI-E, #128) → WI-E: cross-deployment replay rejection; instance-mismatch fail-closed
 *
 * To un-skip when WI-A/WI-E land:
 *   1. Implement authFixtures.instanceBinding(...) in packages/worker/src/test-support/fixtures.ts
 *      with the correct binding-claim name, timestamp unit, and JWK-thumbprint algorithm.
 *   2. Remove the featurePending wrapper (or convert to a plain describe block).
 *   3. Run: pnpm --filter @tila/integration-tests exec vitest run src/auth-instance-binding.test.ts
 *
 * Cross-package mock limitation:
 *   See auth-harness.README.md — D1-store-method mocking is not exercised here.
 *   Instance-binding validation is tested at the payload/binding-claim level.
 *
 * Note: SCREAMING_CASE error codes are never used in this file (contract AC-4).
 * All error codes use lowercase-kebab form matching the source.
 */
import { authFixtures, featurePending } from "@tila/worker/test-support";

// ---------------------------------------------------------------------------
// FEATURE-PENDING(WI-E, #128): cross-deployment replay rejection
// ---------------------------------------------------------------------------

const fpE = featurePending(
  "WI-E",
  128,
  "cross-deployment replay rejection and instance-mismatch fail-closed",
);

fpE.describe("cross-deployment replay rejection", () => {
  fpE.it(
    "session token issued on instance-A is rejected when replayed on instance-B",
    async () => {
      // shape TBD — owned by WI-E (cross-deployment replay).
      //
      // When WI-E lands:
      //   1. Build an instance-binding claim for instance-A using instanceBinding().
      //   2. Mint a session token that carries the instance-A binding claim.
      //   3. Present that token to an app wired to instance-B.
      //   4. Assert: 401, error.code === "instance-mismatch" (or the WI-E code).
      const _binding = await authFixtures.instanceBinding({
        // shape TBD — owned by WI-A/WI-E
        instanceId: "instance-a",
      });
      throw new Error("shape TBD — owned by WI-E");
    },
  );

  fpE.it(
    "instance-mismatch fails closed — no partial data returned on mismatch",
    async () => {
      // shape TBD — owned by WI-E.
      //
      // When WI-E lands: assert that a mismatched-instance request returns
      // an error body with ok=false and no project/user data leaked.
      const _binding = await authFixtures.instanceBinding({
        // shape TBD — owned by WI-A/WI-E
        instanceId: "wrong-instance",
      });
      throw new Error("shape TBD — owned by WI-E");
    },
  );
});

// ---------------------------------------------------------------------------
// FEATURE-PENDING(WI-A, #123): timestamp ms-unification boundary gate
// ---------------------------------------------------------------------------

const fpA = featurePending(
  "WI-A",
  123,
  "off-by-1000 timestamp-unit boundary: ms vs s confusion rejected",
);

fpA.describe("timestamp-unit off-by-1000 boundary", () => {
  fpA.it(
    "binding claim with timestamp in milliseconds accepted (canonical unit after WI-A)",
    async () => {
      // shape TBD — owned by WI-A (timestamp ms-unification).
      //
      // When WI-A lands and pins the canonical timestamp unit:
      //   1. Build a binding claim with timestampMs set to Date.now() (ms).
      //   2. Present the token with this binding claim.
      //   3. Assert: 200 (valid claim accepted).
      //
      // This is the WI-A canonical fail-open gate: the first request after ms
      // unification should pass, not be rejected as "off by 1000x".
      const _binding = await authFixtures.instanceBinding({
        // shape TBD — owned by WI-A/WI-E
        instanceId: "local-instance",
        timestampMs: Date.now(),
      });
      throw new Error("shape TBD — owned by WI-A");
    },
  );

  fpA.it(
    "binding claim with timestamp in seconds (off by 1000) is rejected",
    async () => {
      // shape TBD — owned by WI-A.
      //
      // When WI-A lands:
      //   1. Build a binding claim with timestampMs set to Math.floor(Date.now() / 1000)
      //      (seconds instead of the canonical milliseconds).
      //   2. Present the token.
      //   3. Assert: 401, error.code indicates timestamp-unit mismatch.
      //
      // This guards the WI-A canonical fail-open gate: off-by-1000 timestamps must
      // be rejected to prevent a silent ms/s unit confusion from bypassing the check.
      const _binding = await authFixtures.instanceBinding({
        // shape TBD — owned by WI-A/WI-E
        instanceId: "local-instance",
        timestampMs: Math.floor(Date.now() / 1000), // wrong unit: seconds not ms
      });
      throw new Error("shape TBD — owned by WI-A");
    },
  );
});
