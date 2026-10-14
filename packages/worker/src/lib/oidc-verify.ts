/**
 * OIDC JWT verification
 *
 * Two public entry-points:
 *
 * 1. `verifyOidcJwt(token, {issuer, audience, jwksUri})` — generic core.
 *    Accepts any RS256-signed JWT, fetches JWKS via the hardened `oidcFetch`
 *    wrapper, and returns the raw `{header, payload}` without any coercion.
 *
 * 2. `verifyOidcToken(token, expectedAudience, trustedIssuers?)` — Actions wrapper.
 *    Selects an exact deployment-trusted issuer before any fetch, delegates
 *    verification, then attaches the configured repository host.
 *
 * JWKS cache and rotation/eviction bookkeeping are isolated by exact issuer
 * AND configured JWKS URI. Length-prefixed namespace keys prevent crafted kid
 * collisions. In-flight fetches from an older configuration own only their
 * original namespace, including eviction and rotation-retry timestamps.
 */

import { base64UrlDecode } from "./base64url";
import { actionsTrustedIssuers } from "./github-actions-trust";
import { OidcFetchError, oidcFetch } from "./oidc-fetch";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface OidcClaims {
  iss: string;
  /** Derived only from deployment configuration after JWT verification. */
  repository_host: string;
  aud: string | string[];
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
  ref?: string;
  sha: string;
  workflow: string;
  run_id: number; // Coerced from string in JWT
  run_number: number; // Coerced from string in JWT
  run_attempt: number; // Coerced from string in JWT
  environment?: string;
  event_name: string;
  repository_visibility: string;
  job_workflow_ref?: string;
}

export type OidcVerificationErrorCode =
  | "oidc-invalid-token"
  | "oidc-invalid-issuer"
  | "oidc-invalid-audience"
  | "oidc-token-expired"
  | "oidc-signature-invalid"
  | "oidc-jwks-unavailable"
  | "oidc-invalid-configuration";

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
// JWKS cache — three maps for issuer/URI isolation and eviction
// ---------------------------------------------------------------------------

/** Length-prefix the exact issuer/URI namespace so arbitrary kid values cannot collide. */
function cacheKey(namespace: string, kid: string): string {
  return `${namespace.length}:${namespace}:${kid}`;
}

/** `kid → CryptoKey` — keyed by the length-prefixed issuer/URI namespace. */
const jwksCache = new Map<string, CryptoKey>();

/** Per-issuer/URI timestamp of the last successful JWKS fetch. */
const lastFetchedAt = new Map<string, number>();

/** Per-issuer/URI set of (raw) kid values currently loaded into `jwksCache`. */
const namespaceKids = new Map<string, Set<string>>();

const JWKS_TTL_MS = 60 * 60 * 1000; // 1 hour

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
  namespaceKids.clear();
}

// ---------------------------------------------------------------------------
// JWKS fetch + import
// ---------------------------------------------------------------------------

/**
 * Fetch the JWKS at `jwksUri` and import keys into `jwksCache` under the
 * given `issuer` namespace.  Stamps `lastFetchedAt` on success.
 *
 * Evict and replace only this issuer/URI namespace; other configured sources
 * retain their independent key sets and rotation timestamps.
 */
async function fetchJwks(issuer: string, jwksUri: string): Promise<void> {
  // Every fetch owns only its exact issuer + configured endpoint namespace.
  // A slower fetch from an old configuration cannot overwrite new-source keys.
  const namespace = JSON.stringify([issuer, jwksUri]);
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

  // Evict only this exact issuer/URI source before loading its new key set.
  const currentKids = namespaceKids.get(namespace);
  if (currentKids) {
    for (const kid of currentKids) {
      jwksCache.delete(cacheKey(namespace, kid));
    }
    namespaceKids.delete(namespace);
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

      jwksCache.set(cacheKey(namespace, jwk.kid), key);
      // Only add to the kid index after successful importKey.
      newKids.add(jwk.kid);
    } catch (err) {
      console.warn(
        `Failed to import JWKS key ${jwk.kid} for issuer ${issuer}:`,
        err,
      );
    }
  }

  namespaceKids.set(namespace, newKids);
  lastFetchedAt.set(namespace, Date.now());
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
  const namespace = JSON.stringify([issuer, jwksUri]);
  const ck = cacheKey(namespace, kid);
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
  if (
    !valid &&
    Date.now() - (lastFetchedAt.get(namespace) ?? 0) < JWKS_TTL_MS
  ) {
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
 * Delegates to `verifyOidcJwt` with an explicit trusted issuer and applies the
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
  trustedIssuers?: string,
): Promise<OidcClaims> {
  const trusted = actionsTrustedIssuers(trustedIssuers);
  if (!trusted) {
    throw new OidcVerificationError(
      "oidc-invalid-configuration",
      "GitHub Actions trusted issuer configuration is invalid",
    );
  }
  let unverifiedIssuer: unknown;
  try {
    const parts = token.split(".");
    if (parts.length !== 3) throw new Error("Invalid JWT");
    unverifiedIssuer = JSON.parse(
      new TextDecoder().decode(base64UrlDecode(parts[1])),
    )?.iss;
  } catch {
    throw new OidcVerificationError(
      "oidc-invalid-token",
      "Invalid JWT payload",
    );
  }
  const entry = trusted.find(
    (candidate) => candidate.issuer === unverifiedIssuer,
  );
  if (!entry) {
    throw new OidcVerificationError(
      "oidc-invalid-issuer",
      "GitHub Actions issuer is not trusted by this deployment",
    );
  }
  const { payload } = await verifyOidcJwt(token, {
    issuer: entry.issuer,
    audience: expectedAudience,
    jwksUri: entry.jwks_uri,
  });

  const requiredString = (name: string): string => {
    const value = payload[name];
    if (typeof value !== "string" || value.length === 0) {
      throw new OidcVerificationError(
        "oidc-invalid-token",
        `Missing or invalid ${name} claim`,
      );
    }
    return value;
  };
  const optionalString = (name: string): string | undefined => {
    const value = payload[name];
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "string" || value.length === 0) {
      throw new OidcVerificationError(
        "oidc-invalid-token",
        `Invalid ${name} claim`,
      );
    }
    return value;
  };
  const requiredNumber = (name: string): number => {
    const value = payload[name];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new OidcVerificationError(
        "oidc-invalid-token",
        `Missing or invalid ${name} claim`,
      );
    }
    return value;
  };
  const requiredPositiveInteger = (name: string): number => {
    const value = Number(payload[name]);
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new OidcVerificationError(
        "oidc-invalid-token",
        `Missing or invalid ${name} claim`,
      );
    }
    return value;
  };
  const aud = payload.aud;
  if (
    !(
      typeof aud === "string" ||
      (Array.isArray(aud) && aud.every((value) => typeof value === "string"))
    )
  ) {
    throw new OidcVerificationError(
      "oidc-invalid-token",
      "Missing or invalid aud claim",
    );
  }

  const iat = requiredNumber("iat");
  if (iat > Math.floor(Date.now() / 1000)) {
    throw new OidcVerificationError(
      "oidc-token-expired",
      "Token issued in the future",
    );
  }
  return {
    iss: requiredString("iss"),
    repository_host: entry.host,
    aud,
    sub: requiredString("sub"),
    exp: requiredNumber("exp"),
    iat,
    nbf: requiredNumber("nbf"),
    jti: requiredString("jti"),
    repository: requiredString("repository"),
    repository_id: requiredPositiveInteger("repository_id"),
    repository_owner: requiredString("repository_owner"),
    repository_owner_id: requiredPositiveInteger("repository_owner_id"),
    actor: requiredString("actor"),
    actor_id: requiredPositiveInteger("actor_id"),
    ref: optionalString("ref"),
    sha: requiredString("sha"),
    workflow: requiredString("workflow"),
    run_id: requiredPositiveInteger("run_id"),
    run_number: requiredPositiveInteger("run_number"),
    run_attempt: requiredPositiveInteger("run_attempt"),
    environment: optionalString("environment"),
    event_name: requiredString("event_name"),
    repository_visibility: requiredString("repository_visibility"),
    job_workflow_ref: optionalString("job_workflow_ref"),
  };
}
