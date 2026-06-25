/**
 * OIDC JWT verification
 *
 * Two public entry-points:
 *
 * 1. `verifyOidcJwt(token, {issuer, audience, jwksUri})` — generic core.
 *    Accepts any RS256-signed JWT, fetches JWKS via the hardened `oidcFetch`
 *    wrapper, and returns the raw `{header, payload}` without any coercion.
 *
 * 2. `verifyOidcToken(token, expectedAudience)` — GitHub-Actions wrapper.
 *    Delegates to `verifyOidcJwt` with GitHub constants and applies the
 *    numeric-field coercion required by `OidcClaims`.  Caller signature and
 *    return type are unchanged from the pre-generalisation version.
 *
 * JWKS cache is keyed by `${issuer.length}:${issuer}:${kid}` (length-prefix
 * prevents a crafted kid from colliding across issuers).  Per-issuer
 * `lastFetchedAt` and `issuerKids` bookkeeping enable TTL-guarded rotation
 * retry and per-issuer eviction.
 */

import { base64UrlDecode } from "./base64url";
import { OidcFetchError, oidcFetch } from "./oidc-fetch";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface OidcClaims {
  iss: string;
  aud: string;
  sub: string;
  exp: number;
  iat: number;
  nbf: number;
  jti: string;
  repository: string;
  repository_id: number; // Coerced from string in JWT
  repository_owner: string;
  repository_owner_id: number; // Coerced from string in JWT
  actor: string;
  actor_id: number; // Coerced from string in JWT
  ref: string;
  sha: string;
  workflow: string;
  run_id: number; // Coerced from string in JWT
  run_number: number; // Coerced from string in JWT
  run_attempt: number; // Coerced from string in JWT
  environment: string;
  event_name: string;
  repository_visibility: string;
  job_workflow_ref: string;
}

export type OidcVerificationErrorCode =
  | "oidc-invalid-token"
  | "oidc-invalid-issuer"
  | "oidc-invalid-audience"
  | "oidc-token-expired"
  | "oidc-signature-invalid"
  | "oidc-jwks-unavailable";

export class OidcVerificationError extends Error {
  constructor(
    public readonly code: OidcVerificationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "OidcVerificationError";
  }
}

export interface OidcVerifyParams {
  /** Expected value of the `iss` claim. */
  issuer: string;
  /** Expected `aud` claim (string or array membership). */
  audience: string;
  /** JWKS endpoint URL.  Must be pre-resolved — never derived from payload. */
  jwksUri: string;
}

export interface VerifiedOidcResult {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// JWKS cache — three maps for per-issuer isolation and eviction
// ---------------------------------------------------------------------------

/**
 * Build the cache key for a (issuer, kid) pair.
 *
 * Length-prefix defeats a crafted kid that encodes another issuer's key path.
 * E.g. kid = `37:https://issuer-a.example.com:real-kid` looks identical to
 * the legitimate key for issuer A — but only when the issuer length is ALSO
 * 37. A different issuer produces a different prefix even with the same kid.
 */
function cacheKey(issuer: string, kid: string): string {
  return `${issuer.length}:${issuer}:${kid}`;
}

/** `kid → CryptoKey` — keyed by the length-prefixed cache key above. */
const jwksCache = new Map<string, CryptoKey>();

/** Per-issuer timestamp of the last successful JWKS fetch. */
const lastFetchedAt = new Map<string, number>();

/** Per-issuer set of (raw) kid values currently loaded into `jwksCache`. */
const issuerKids = new Map<string, Set<string>>();

const JWKS_TTL_MS = 60 * 60 * 1000; // 1 hour
const JWKS_MAX_KEYS = 10; // per-issuer eviction threshold

// ---------------------------------------------------------------------------
// GitHub-specific constants (preserved for the backward-compat wrapper)
// ---------------------------------------------------------------------------

const GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com";
const GITHUB_JWKS_URL =
  "https://token.actions.githubusercontent.com/.well-known/jwks";

// ---------------------------------------------------------------------------
// Cache helpers
// ---------------------------------------------------------------------------

/**
 * Clear the JWKS cache (for testing only).
 * Clears all three maps so cache state never leaks across tests.
 *
 * @internal
 */
export function clearCacheForTesting(): void {
  jwksCache.clear();
  lastFetchedAt.clear();
  issuerKids.clear();
}

// ---------------------------------------------------------------------------
// JWKS fetch + import
// ---------------------------------------------------------------------------

/**
 * Fetch the JWKS at `jwksUri` and import keys into `jwksCache` under the
 * given `issuer` namespace.  Stamps `lastFetchedAt` on success.
 *
 * Per-issuer eviction: if loading this issuer's new key set would push the
 * total cache size beyond `JWKS_MAX_KEYS`, evict the current keys for this
 * issuer before importing.
 */
async function fetchJwks(issuer: string, jwksUri: string): Promise<void> {
  let res: Response;
  try {
    res = await oidcFetch(jwksUri);
  } catch (err) {
    if (err instanceof OidcFetchError) {
      throw new OidcVerificationError(
        "oidc-jwks-unavailable",
        `OIDC fetch error fetching JWKS: ${err.message}`,
      );
    }
    throw err;
  }

  if (!res.ok) {
    throw new OidcVerificationError(
      "oidc-jwks-unavailable",
      `Failed to fetch JWKS (status ${res.status})`,
    );
  }

  const jwks = (await res.json()) as {
    keys: (JsonWebKey & { kid?: string })[];
  };

  // Per-issuer eviction: remove existing keys for this issuer before re-loading.
  const currentKids = issuerKids.get(issuer);
  if (currentKids) {
    for (const kid of currentKids) {
      jwksCache.delete(cacheKey(issuer, kid));
    }
    issuerKids.delete(issuer);
  }

  const newKids = new Set<string>();

  for (const jwk of jwks.keys) {
    if (!jwk.kid) continue;

    try {
      const key = await crypto.subtle.importKey(
        "jwk",
        jwk,
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        true,
        ["verify"],
      );

      jwksCache.set(cacheKey(issuer, jwk.kid), key);
      // Only add to the kid index after successful importKey.
      newKids.add(jwk.kid);
    } catch (err) {
      console.warn(
        `Failed to import JWKS key ${jwk.kid} for issuer ${issuer}:`,
        err,
      );
    }
  }

  issuerKids.set(issuer, newKids);
  lastFetchedAt.set(issuer, Date.now());
}

// ---------------------------------------------------------------------------
// Generic core: verifyOidcJwt
// ---------------------------------------------------------------------------

/**
 * Verify an RS256 OIDC JWT against a caller-supplied issuer, audience, and
 * JWKS URI.  Returns the raw decoded `{header, payload}` — no coercion.
 *
 * @throws OidcVerificationError on any validation failure.
 */
export async function verifyOidcJwt(
  token: string,
  params: OidcVerifyParams,
): Promise<VerifiedOidcResult> {
  const { issuer, audience, jwksUri } = params;

  // 1. Split and basic structure check.
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new OidcVerificationError(
      "oidc-invalid-token",
      "JWT must have 3 parts",
    );
  }

  const [headerB64, payloadB64, signatureB64] = parts;

  // 2. Decode header and payload.
  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;

  try {
    header = JSON.parse(new TextDecoder().decode(base64UrlDecode(headerB64)));
    payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(payloadB64)));
  } catch {
    throw new OidcVerificationError(
      "oidc-invalid-token",
      "Failed to parse JWT header or payload",
    );
  }

  // 3. Algorithm check — only RS256 supported.
  if (header.alg !== "RS256") {
    throw new OidcVerificationError(
      "oidc-invalid-token",
      `Unsupported algorithm: ${header.alg} (only RS256 is supported)`,
    );
  }

  // 4. Issuer assertion — BEFORE any network call.
  //    Never derive fetch URLs from payload.iss; use params.jwksUri.
  if (payload.iss !== issuer) {
    throw new OidcVerificationError(
      "oidc-invalid-issuer",
      `Invalid issuer: ${payload.iss} (expected ${issuer})`,
    );
  }

  // 5. Audience check.  RFC 7519 allows aud to be a string or array.
  //    Absent aud is explicitly rejected (not via incidental falsy path).
  const audClaim = payload.aud;
  if (audClaim === undefined || audClaim === null) {
    throw new OidcVerificationError(
      "oidc-invalid-audience",
      "Missing aud claim",
    );
  }
  const audiences = Array.isArray(audClaim) ? audClaim : [audClaim];
  if (!audiences.includes(audience)) {
    throw new OidcVerificationError(
      "oidc-invalid-audience",
      `Invalid audience: ${JSON.stringify(audClaim)} (expected ${audience})`,
    );
  }

  // 6. Time claims.
  const now = Math.floor(Date.now() / 1000);

  if (typeof payload.exp !== "number" || payload.exp <= now) {
    throw new OidcVerificationError(
      "oidc-token-expired",
      `Token expired at ${payload.exp} (current time: ${now})`,
    );
  }

  if (typeof payload.nbf === "number" && payload.nbf > now) {
    throw new OidcVerificationError(
      "oidc-token-expired",
      `Token not yet valid (nbf: ${payload.nbf}, current time: ${now})`,
    );
  }

  // 7. Kid extraction — ignore jku/x5u header fields entirely.
  const kid = header.kid as string | undefined;
  if (!kid) {
    throw new OidcVerificationError(
      "oidc-invalid-token",
      "Missing kid in JWT header",
    );
  }

  // 8. Key lookup — fetch if not cached for this issuer.
  const ck = cacheKey(issuer, kid);
  let key = jwksCache.get(ck);

  if (!key) {
    await fetchJwks(issuer, jwksUri);
    key = jwksCache.get(ck);
  }

  if (!key) {
    throw new OidcVerificationError(
      "oidc-jwks-unavailable",
      `Key with kid ${kid} not found in JWKS for issuer ${issuer}`,
    );
  }

  // 9. Signature verification.
  const data = `${headerB64}.${payloadB64}`;
  const signature = base64UrlDecode(signatureB64);

  let valid = false;
  try {
    valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      signature.buffer as ArrayBuffer,
      new TextEncoder().encode(data).buffer as ArrayBuffer,
    );
  } catch {
    valid = false;
  }

  // 10. Rotation retry — if signature fails and the cached keys are still
  //     within the TTL, force an unconditional re-fetch so that key rotation
  //     that happened within the TTL window is actually picked up, then
  //     re-verify once with the freshly imported key for this kid.
  //
  //     Guard: retry only when the cache is considered fresh (last fetch was
  //     within JWKS_TTL_MS).  `?? 0` prevents NaN arithmetic without changing
  //     the "retry on fresh cache" semantics.
  if (!valid && Date.now() - (lastFetchedAt.get(issuer) ?? 0) < JWKS_TTL_MS) {
    // Force unconditional re-fetch (don't short-circuit on current freshness).
    await fetchJwks(issuer, jwksUri);
    const retryKey = jwksCache.get(ck) ?? null;

    if (retryKey) {
      try {
        valid = await crypto.subtle.verify(
          "RSASSA-PKCS1-v1_5",
          retryKey,
          signature.buffer as ArrayBuffer,
          new TextEncoder().encode(data).buffer as ArrayBuffer,
        );
      } catch {
        valid = false;
      }
    }
  }

  if (!valid) {
    throw new OidcVerificationError(
      "oidc-signature-invalid",
      "JWT signature verification failed",
    );
  }

  return { header, payload };
}

// ---------------------------------------------------------------------------
// Backward-compatible GitHub-Actions wrapper: verifyOidcToken
// ---------------------------------------------------------------------------

/**
 * Verify an OIDC JWT from GitHub Actions.
 *
 * Delegates to `verifyOidcJwt` with GitHub constants and applies the
 * numeric-field coercion required by the `OidcClaims` interface.
 *
 * @param token - The OIDC JWT to verify.
 * @param expectedAudience - The expected 'aud' claim (e.g., worker URL).
 * @returns Parsed and verified OIDC claims with coerced numeric fields.
 * @throws OidcVerificationError on any validation failure.
 */
export async function verifyOidcToken(
  token: string,
  expectedAudience: string,
): Promise<OidcClaims> {
  const { payload } = await verifyOidcJwt(token, {
    issuer: GITHUB_OIDC_ISSUER,
    audience: expectedAudience,
    jwksUri: GITHUB_JWKS_URL,
  });

  // Coerce numeric ID fields from string to number.
  // GitHub OIDC JWTs encode these as strings; downstream code expects numbers.
  const repository_id = Number(payload.repository_id);
  const repository_owner_id = Number(payload.repository_owner_id);
  const actor_id = Number(payload.actor_id);
  const run_id = Number(payload.run_id);
  const run_number = Number(payload.run_number);
  const run_attempt = Number(payload.run_attempt);

  return {
    iss: payload.iss as string,
    aud: payload.aud as string,
    sub: payload.sub as string,
    exp: payload.exp as number,
    iat: payload.iat as number,
    nbf: payload.nbf as number,
    jti: payload.jti as string,
    repository: payload.repository as string,
    repository_id,
    repository_owner: payload.repository_owner as string,
    repository_owner_id,
    actor: payload.actor as string,
    actor_id,
    ref: payload.ref as string,
    sha: payload.sha as string,
    workflow: payload.workflow as string,
    run_id,
    run_number,
    run_attempt,
    environment: payload.environment as string,
    event_name: payload.event_name as string,
    repository_visibility: payload.repository_visibility as string,
    job_workflow_ref: payload.job_workflow_ref as string,
  };
}
