import { OidcFetchError, isBlockedHost, oidcFetch } from "./oidc-fetch";

/**
 * OIDC Discovery (WI-B2): resolve an issuer's JWKS URI via its
 * `.well-known/openid-configuration` document, fetched through the hardened
 * `oidcFetch` egress wrapper.
 *
 * The `issuer` passed here is ALWAYS the per-project configured `oidc_issuer`
 * (operator-controlled) — never a value taken from a token. Combined with
 * `oidcFetch`'s SSRF guard this bounds the discovery fetch target.
 *
 * Residual risk: DNS-rebinding of the discovered `jwks_uri` host cannot be
 * closed inside the Workers isolate (no DNS-resolution hook); the
 * operator-curated per-project issuer is the compensating control. Mirrors the
 * note in oidc-fetch.ts.
 */

const DISCOVERY_TTL_MS = 60 * 60 * 1000; // 1h, mirrors the JWKS cache TTL

interface DiscoveryCacheEntry {
  jwksUri: string;
  fetchedAt: number;
}

const discoveryCache = new Map<string, DiscoveryCacheEntry>();

export type OidcDiscoveryErrorCode =
  | "discovery-unreachable"
  | "discovery-invalid";

export class OidcDiscoveryError extends Error {
  readonly code: OidcDiscoveryErrorCode;
  constructor(code: OidcDiscoveryErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "OidcDiscoveryError";
  }
}

/** Test-only: clear the per-issuer discovery cache. */
export function clearDiscoveryCacheForTesting(): void {
  discoveryCache.clear();
}

/**
 * Resolve the JWKS URI for an issuer. Returns a validated https `jwks_uri`
 * whose host is not SSRF-blocked. Throws `OidcDiscoveryError` (fail-closed) on
 * any failure. Caches the result per issuer for `DISCOVERY_TTL_MS`.
 */
export async function resolveJwksUri(issuer: string): Promise<string> {
  const cached = discoveryCache.get(issuer);
  if (cached && Date.now() - cached.fetchedAt < DISCOVERY_TTL_MS) {
    return cached.jwksUri;
  }

  // OIDC Discovery 1.0: append the well-known path to the issuer, preserving
  // any path component (and stripping a single trailing slash).
  const discoveryUrl = `${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`;

  let doc: { issuer?: unknown; jwks_uri?: unknown };
  try {
    const res = await oidcFetch(discoveryUrl);
    doc = (await res.json()) as typeof doc;
  } catch (err) {
    if (err instanceof OidcFetchError) {
      throw new OidcDiscoveryError(
        "discovery-unreachable",
        `OIDC discovery fetch failed for ${issuer}: ${err.code}`,
      );
    }
    throw new OidcDiscoveryError(
      "discovery-unreachable",
      `OIDC discovery document for ${issuer} could not be parsed`,
    );
  }

  // The discovery document MUST self-identify with the requested issuer.
  if (doc.issuer !== issuer) {
    throw new OidcDiscoveryError(
      "discovery-invalid",
      `OIDC discovery issuer mismatch for ${issuer}`,
    );
  }

  const jwksUri = doc.jwks_uri;
  if (typeof jwksUri !== "string" || jwksUri.length === 0) {
    throw new OidcDiscoveryError(
      "discovery-invalid",
      `OIDC discovery document for ${issuer} has no jwks_uri`,
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(jwksUri);
  } catch {
    throw new OidcDiscoveryError(
      "discovery-invalid",
      `OIDC discovery jwks_uri for ${issuer} is not a valid URL`,
    );
  }
  if (parsed.protocol !== "https:") {
    throw new OidcDiscoveryError(
      "discovery-invalid",
      `OIDC discovery jwks_uri for ${issuer} is not https`,
    );
  }
  // Close the candidate jwks_uri SSRF gap at the discovery layer (defense in
  // depth — the subsequent verifyOidcJwt→oidcFetch(jwksUri) re-guards it too).
  if (isBlockedHost(parsed.hostname)) {
    throw new OidcDiscoveryError(
      "discovery-invalid",
      `OIDC discovery jwks_uri for ${issuer} resolves to a blocked host`,
    );
  }

  discoveryCache.set(issuer, { jwksUri, fetchedAt: Date.now() });
  return jwksUri;
}
