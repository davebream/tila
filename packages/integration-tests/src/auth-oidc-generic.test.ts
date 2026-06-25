/**
 * auth-oidc-generic.test.ts — skip-gated pending tests for generic OIDC and DPoP auth.
 *
 * ALL cases in this file are skip-gated via featurePending. The production features
 * they test (WI-B1 generic OIDC issuer validation, WI-G DPoP proof verification)
 * do not exist on main yet. Bodies reference the deferred mintOidcJwt /
 * buildDpopProof fixture stubs which throw "shape TBD" — these throws are safe
 * because the tests are skipped before their bodies execute.
 *
 * Un-skip map:
 *   FEATURE-PENDING(WI-B1, #124) → WI-B1: generic OIDC issuer allowlist; unconfigured issuer rejected
 *   FEATURE-PENDING(WI-G, #130)  → WI-G: DPoP proof required; mismatched htu/htm rejected
 *
 * To un-skip when WI-B1 lands:
 *   1. Implement authFixtures.mintOidcJwt(...) in packages/worker/src/test-support/fixtures.ts
 *      with the correct iss/sub/aud/claims shape from the WI-B1 production implementation.
 *   2. Remove the featurePending wrapper (or convert to a plain describe block).
 *   3. Run: pnpm --filter @tila/integration-tests exec vitest run src/auth-oidc-generic.test.ts
 *
 * To un-skip when WI-G lands:
 *   1. Implement authFixtures.buildDpopProof(...) in packages/worker/src/test-support/fixtures.ts
 *      with the correct DPoP JWS shape from the WI-G production implementation.
 *   2. Remove the featurePending wrapper (or convert to a plain describe block).
 *   3. Run: pnpm --filter @tila/integration-tests exec vitest run src/auth-oidc-generic.test.ts
 *
 * Cross-package mock limitation:
 *   See auth-harness.README.md — D1-store-method mocking is not exercised here.
 *   OIDC issuer validation and DPoP checks are tested at the token/proof-shape level.
 *
 * Note: SCREAMING_CASE error codes are never used in this file (contract AC-4).
 * All error codes use lowercase-kebab form matching the source.
 */
import { authFixtures, featurePending } from "@tila/worker/test-support";

// ---------------------------------------------------------------------------
// FEATURE-PENDING(WI-B1, #124): generic OIDC issuer validation
// ---------------------------------------------------------------------------

const fpB1 = featurePending(
  "WI-B1",
  124,
  "generic OIDC issuer allowlist: unconfigured or forbidden issuers rejected",
);

fpB1.describe("OIDC token from unconfigured issuer", () => {
  fpB1.it(
    "OIDC token from an issuer not in the configured allowlist is rejected",
    async () => {
      // shape TBD — owned by WI-B1 (generic OIDC verifier).
      //
      // When WI-B1 lands:
      //   1. Mint an OIDC JWT from a random/unconfigured issuer using mintOidcJwt().
      //   2. Present the token to the OIDC exchange route.
      //   3. Assert: 401, error.code === "issuer-not-allowed" (or the WI-B1 code).
      const _jwt = await authFixtures.mintOidcJwt({
        // shape TBD — owned by WI-B1
        iss: "https://unconfigured-issuer.example.com",
        sub: "test-subject",
        aud: "tila",
      });
      throw new Error("shape TBD — owned by WI-B1");
    },
  );

  fpB1.it(
    "OIDC token from an explicitly forbidden issuer is rejected",
    async () => {
      // shape TBD — owned by WI-B1.
      //
      // When WI-B1 lands:
      //   1. Configure the app with an issuer allowlist that does NOT include
      //      "https://forbidden.example.com".
      //   2. Mint an OIDC JWT with iss: "https://forbidden.example.com".
      //   3. Present the token.
      //   4. Assert: 401, error.code indicates issuer is not allowed.
      const _jwt = await authFixtures.mintOidcJwt({
        // shape TBD — owned by WI-B1
        iss: "https://forbidden.example.com",
        sub: "test-subject",
        aud: "tila",
      });
      throw new Error("shape TBD — owned by WI-B1");
    },
  );
});

// ---------------------------------------------------------------------------
// FEATURE-PENDING(WI-G, #130): DPoP proof verification
// ---------------------------------------------------------------------------

const fpG = featurePending(
  "WI-G",
  130,
  "DPoP-required routes: no-proof and mismatched htu/htm rejected",
);

fpG.describe("DPoP proof required on DPoP-enabled routes", () => {
  fpG.it(
    "request to DPoP-required route without a proof header is rejected",
    async () => {
      // shape TBD — owned by WI-G (DPoP verifier).
      //
      // When WI-G lands:
      //   1. Present a valid session or OIDC token to a DPoP-required route,
      //      but omit the DPoP proof header.
      //   2. Assert: 401, error.code === "dpop-required" (or the WI-G code).
      throw new Error("shape TBD — owned by WI-G");
    },
  );

  fpG.it("DPoP proof with mismatched htu (wrong URL) is rejected", async () => {
    // shape TBD — owned by WI-G.
    //
    // When WI-G lands:
    //   1. Build a DPoP proof for "https://other-url.example.com" using buildDpopProof().
    //   2. Present it to the actual route URL.
    //   3. Assert: 401, error.code indicates htu mismatch.
    const _proof = await authFixtures.buildDpopProof({
      // shape TBD — owned by WI-G
      htm: "POST",
      htu: "https://other-url.example.com/wrong-path",
    });
    throw new Error("shape TBD — owned by WI-G");
  });

  fpG.it(
    "DPoP proof with mismatched htm (wrong method) is rejected",
    async () => {
      // shape TBD — owned by WI-G.
      //
      // When WI-G lands:
      //   1. Build a DPoP proof with htm: "GET" but send a POST request (or vice versa).
      //   2. Assert: 401, error.code indicates htm mismatch.
      const _proof = await authFixtures.buildDpopProof({
        // shape TBD — owned by WI-G
        htm: "GET", // wrong method for the actual request
        htu: "https://tila.example.com/projects/proj-1/tasks",
      });
      throw new Error("shape TBD — owned by WI-G");
    },
  );
});
