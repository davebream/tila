/**
 * OIDC JWT verification for GitHub Actions OIDC tokens
 *
 * Verifies RS256-signed JWTs from GitHub Actions against GitHub's JWKS endpoint.
 * Caches public keys with 1-hour TTL and retry-on-rotation logic.
 */

import { base64UrlDecode } from "./base64url";

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

// JWKS cache: Map<kid, CryptoKey>
const jwksCache = new Map<string, CryptoKey>();
let lastFetchedAt = 0;
const JWKS_TTL_MS = 60 * 60 * 1000; // 1 hour
const JWKS_MAX_KEYS = 10;

const GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com";
const GITHUB_JWKS_URL =
  "https://token.actions.githubusercontent.com/.well-known/jwks";

/**
 * Clear the JWKS cache (for testing only)
 * @internal
 */
export function clearCacheForTesting(): void {
  jwksCache.clear();
  lastFetchedAt = 0;
}

/**
 * Fetch JWKS from GitHub and import keys into the cache
 */
async function fetchJwks(): Promise<void> {
  const res = await fetch(GITHUB_JWKS_URL);

  if (!res.ok) {
    throw new OidcVerificationError(
      "oidc-jwks-unavailable",
      `Failed to fetch JWKS from GitHub (status ${res.status})`,
    );
  }

  const jwks = (await res.json()) as {
    keys: (JsonWebKey & { kid?: string })[];
  };

  // Clear old cache if we're about to exceed max keys
  if (jwksCache.size + jwks.keys.length > JWKS_MAX_KEYS) {
    jwksCache.clear();
  }

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

      jwksCache.set(jwk.kid, key);
    } catch (err) {
      // Skip keys that fail to import (e.g., unsupported algorithm)
      console.warn(`Failed to import key ${jwk.kid}:`, err);
    }
  }

  lastFetchedAt = Date.now();
}

/**
 * Get a key from cache, or fetch fresh JWKS if miss/stale
 */
async function getKey(
  kid: string,
  allowFetch: boolean,
): Promise<CryptoKey | null> {
  const cached = jwksCache.get(kid);

  // Cache hit and fresh
  if (cached && Date.now() - lastFetchedAt < JWKS_TTL_MS) {
    return cached;
  }

  // Cache miss or stale — fetch if allowed
  if (allowFetch) {
    await fetchJwks();
    return jwksCache.get(kid) ?? null;
  }

  return null;
}

/**
 * Verify an OIDC JWT from GitHub Actions
 *
 * @param token - The OIDC JWT to verify
 * @param expectedAudience - The expected 'aud' claim (e.g., worker URL)
 * @returns Parsed and verified OIDC claims
 * @throws OidcVerificationError on any validation failure
 */
export async function verifyOidcToken(
  token: string,
  expectedAudience: string,
): Promise<OidcClaims> {
  // Split token into parts
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new OidcVerificationError(
      "oidc-invalid-token",
      "JWT must have 3 parts",
    );
  }

  const [headerB64, payloadB64, signatureB64] = parts;

  // Decode header and payload
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

  // Validate algorithm
  if (header.alg !== "RS256") {
    throw new OidcVerificationError(
      "oidc-invalid-token",
      `Unsupported algorithm: ${header.alg} (only RS256 is supported)`,
    );
  }

  // Validate issuer
  if (payload.iss !== GITHUB_OIDC_ISSUER) {
    throw new OidcVerificationError(
      "oidc-invalid-issuer",
      `Invalid issuer: ${payload.iss} (expected ${GITHUB_OIDC_ISSUER})`,
    );
  }

  // Validate audience. Per RFC 7519, aud may be a single string OR an array of
  // strings; accept either form (and reject an absent aud) for forward-compat
  // with multi-audience OIDC providers.
  const audClaim = payload.aud as unknown;
  const audiences = Array.isArray(audClaim) ? audClaim : [audClaim];
  if (!audiences.includes(expectedAudience)) {
    throw new OidcVerificationError(
      "oidc-invalid-audience",
      `Invalid audience: ${JSON.stringify(audClaim)} (expected ${expectedAudience})`,
    );
  }

  // Validate time claims
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

  // Get key from cache or fetch
  const kid = header.kid as string;
  if (!kid) {
    throw new OidcVerificationError(
      "oidc-invalid-token",
      "Missing kid in JWT header",
    );
  }

  let key = await getKey(kid, true);

  if (!key) {
    throw new OidcVerificationError(
      "oidc-jwks-unavailable",
      `Key with kid ${kid} not found in JWKS`,
    );
  }

  // Verify signature
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

  // On signature failure with cached key, retry with fresh JWKS (handles key rotation)
  if (!valid && Date.now() - lastFetchedAt < JWKS_TTL_MS) {
    key = await getKey(kid, true); // Force fresh fetch

    if (key) {
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
    }
  }

  if (!valid) {
    throw new OidcVerificationError(
      "oidc-signature-invalid",
      "JWT signature verification failed",
    );
  }

  // Coerce numeric ID fields from string to number
  // GitHub OIDC JWTs encode these as strings, but downstream code expects numbers
  const repository_id = Number(payload.repository_id);
  const repository_owner_id = Number(payload.repository_owner_id);
  const actor_id = Number(payload.actor_id);
  const run_id = Number(payload.run_id);
  const run_number = Number(payload.run_number);
  const run_attempt = Number(payload.run_attempt);

  // Return typed claims
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
