/**
 * authFixtures — credential builders for auth integration tests.
 *
 * Extracted verbatim (1-arg form) from packages/worker/src/middleware/auth.test.ts:45.
 * The mintSessionToken helper here is intentionally identical to the original — do
 * not add a second argument for signature forgery. Wrong-key forgery is done by
 * calling app.fetch() with a wrong-key Env, mirroring fetchWithSessionEnv
 * (auth.test.ts:76).
 *
 * DPoP / OIDC / instance-binding fixtures are deferred stubs — their production
 * referents do not exist on main yet. Each throws an error indicating which WI
 * owns the shape. Un-skipping their tests requires implementing the fixture first.
 */
import { SignJWT, importJWK } from "jose";
import { base64UrlDecode, base64UrlEncode } from "../lib/base64url";
import { TEST_HMAC_KEY } from "./env";

// ---------------------------------------------------------------------------
// mintSessionToken — verbatim 1-arg extraction from auth.test.ts:45
// ---------------------------------------------------------------------------

/**
 * Mint a valid tila_s. session token signed with TEST_HMAC_KEY using jose.
 * Format: tila_s.<jwtHeader>.<jwtPayload>.<jwtSignature>
 *
 * Pass overrides to produce invalid/expired payloads for negative tests:
 *   mintSessionToken({ expires_at: Math.floor(Date.now() / 1000) - 10 })  // expired
 *   mintSessionToken({ aud: "wrong" })                                      // bad audience
 *   mintSessionToken({ project_id: "other-project" })                       // wrong project
 *
 * For signature-forgery tests, call app.fetch() with a wrong GITHUB_SESSION_HMAC_KEY
 * in the Env — do NOT add a second argument to this function.
 */
export async function mintSessionToken(
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const payload = {
    project_id: "proj-1",
    github_host: "github.com",
    github_repo_id: 99999,
    github_login: "testuser",
    github_user_id: 12345,
    permission: "write",
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    issued_at: Math.floor(Date.now() / 1000),
    iss: "tila",
    aud: "tila",
    ...overrides,
  };

  const keyBytes = base64UrlDecode(TEST_HMAC_KEY);
  const secret = await importJWK(
    { kty: "oct", k: base64UrlEncode(keyBytes), alg: "HS256" },
    "HS256",
  );

  const jwt = await new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .sign(secret);

  return `tila_s.${jwt}`;
}

// ---------------------------------------------------------------------------
// mintD1Token — generates a plaintext D1 API token
// ---------------------------------------------------------------------------

/**
 * Generate a deterministic plaintext D1 bearer token for testing.
 * The real worker generates cryptographically random tokens; this returns
 * a predictable value for test scenarios.
 */
export function mintD1Token(): string {
  return `tila_${"a".repeat(64)}`;
}

// ---------------------------------------------------------------------------
// hashToken — SHA-256 hex digest (no pepper — test tokens use bare hash)
// ---------------------------------------------------------------------------

/**
 * Hash a plaintext token with plain SHA-256 (no pepper) to the hex digest
 * format used by the worker's token lookup.
 *
 * Matches the token.test.ts helper and the worker's bare-SHA-256 fallback.
 */
export async function hashToken(plaintext: string): Promise<string> {
  const hashBuffer = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(plaintext),
  );
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ---------------------------------------------------------------------------
// Deferred stubs — shape TBD by sibling WIs
// ---------------------------------------------------------------------------

/**
 * DEFERRED STUB — shape TBD, owned by WI-B1 (generic OIDC verifier).
 *
 * Will mint a generic OIDC JWT for testing the OIDC exchange route once
 * WI-B1 lands and pins the claim contract. Until then, calling this throws.
 *
 * To un-skip tests that depend on this: implement the fixture here with the
 * correct iss/sub/aud/claims shape from the WI-B1 production implementation.
 */
export async function mintOidcJwt(_opts: {
  iss: string;
  sub: string;
  aud: string;
  claims?: Record<string, unknown>;
}): Promise<string> {
  throw new Error(
    "mintOidcJwt: shape TBD — owned by WI-B1 (generic OIDC verifier). " +
      "Implement this fixture when WI-B1 lands and pins the claim contract.",
  );
}

/**
 * DEFERRED STUB — shape TBD, owned by WI-G (DPoP proof).
 *
 * Will build a DPoP proof JWS for testing DPoP-required routes once WI-G
 * lands and pins the JWK-thumbprint algorithm, htu canonicalization, and
 * htm format. Until then, calling this throws.
 *
 * To un-skip tests that depend on this: implement the fixture here with the
 * correct DPoP shape from the WI-G production implementation.
 */
export async function buildDpopProof(_opts: {
  htm: string;
  htu: string;
  iat?: number;
}): Promise<string> {
  throw new Error(
    "buildDpopProof: shape TBD — owned by WI-G (DPoP). " +
      "Implement this fixture when WI-G lands and pins the JWK-thumbprint/htu/htm contract.",
  );
}

/**
 * DEFERRED STUB — shape TBD, owned by WI-A / WI-E (instance binding).
 *
 * Will build an instance-binding claim for testing cross-deployment replay
 * rejection once WI-A/WI-E land and pin the binding-claim name, timestamp
 * unit, and JWK-thumbprint algorithm. Until then, calling this throws.
 *
 * To un-skip tests that depend on this: implement the fixture here with the
 * correct instance-binding shape from the WI-A/WI-E production implementation.
 */
export async function instanceBinding(_opts: {
  instanceId: string;
  timestampMs?: number;
}): Promise<Record<string, unknown>> {
  throw new Error(
    "instanceBinding: shape TBD — owned by WI-A/WI-E (instance binding). " +
      "Implement this fixture when WI-A/WI-E land and pin the binding-claim contract.",
  );
}

// ---------------------------------------------------------------------------
// Exported as a namespace for convenient import
// ---------------------------------------------------------------------------

export const authFixtures = {
  mintSessionToken,
  mintD1Token,
  hashToken,
  mintOidcJwt,
  buildDpopProof,
  instanceBinding,
};
