/**
 * OIDC Discovery helper — `resolveJwksUri(issuer)`.
 *
 * Fetches the OIDC Discovery document at
 * `<issuer>/.well-known/openid-configuration` via the hardened `oidcFetch`
 * wrapper (https-only, SSRF guard, no-redirect, timeout, size cap) and
 * extracts the `jwks_uri` from it.
 *
 * Security model
 * --------------
 * - The discovery fetch target is derived from the **operator-configured**
 *   issuer (`_projects.oidc_issuer`), never from the incoming token — so
 *   the primary SSRF surface is bounded by operator trust.
 * - The returned `jwks_uri` is validated: https-only, non-empty, and the
 *   host is checked against `isBlockedHost` to prevent an adversarial
 *   discovery doc from redirecting key fetches to an internal host (R-2/d2).
 * - DNS-rebinding remains a **documented residual risk**: a hostname that
 *   resolves to a private IP at fetch time cannot be caught inside the
 *   Workers isolate.  The operator-curated per-project issuer is the
 *   compensating control (same posture as `oidc-fetch.ts:138-140`).
 *
 * @module
 */

import { OidcFetchError, isBlockedHost, oidcFetch } from "./oidc-fetch";

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

export type OidcDiscoveryErrorCode =
  | "discovery-unreachable"
  | "discovery-invalid";

export class OidcDiscoveryError extends Error {
  readonly code: OidcDiscoveryErrorCode;

  constructor(code: OidcDiscoveryErrorCode, message: string) {
    super(`[${code}] ${message}`);
    this.name = "OidcDiscoveryError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Per-issuer cache (module-level Map, ~1h TTL)
// ---------------------------------------------------------------------------

const DISCOVERY_TTL_MS = 60 * 60 * 1000; // 1 hour

interface CacheEntry {
  jwksUri: string;
  fetchedAt: number;
}

const discoveryCache = new Map<string, CacheEntry>();

/**
 * Clear the per-issuer discovery cache.  Exposed for testing only — never
 * call this from production code.
 *
 * @internal
 */
export function clearDiscoveryCacheForTesting(): void {
  discoveryCache.clear();
}

// ---------------------------------------------------------------------------
// resolveJwksUri
// ---------------------------------------------------------------------------

/**
 * Resolve an OIDC issuer to its JWKS URI via OIDC Discovery.
 *
 * 1. Builds `<issuer>/.well-known/openid-configuration` (strips trailing `/`).
 * 2. Fetches via `oidcFetch` (hardened egress — https-only, SSRF guard, …).
 * 3. Asserts `doc.issuer === issuer` per OIDC Discovery 1.0 §4.3.
 * 4. Validates `doc.jwks_uri`: non-empty, https scheme, and non-blocked host.
 * 5. Caches the result per-issuer for `DISCOVERY_TTL_MS` (~1h).
 *
 * @throws `OidcDiscoveryError("discovery-unreachable")` — fetch failed.
 * @throws `OidcDiscoveryError("discovery-invalid")` — doc validation failed.
 */
export async function resolveJwksUri(issuer: string): Promise<string> {
  // Check per-issuer cache.
  const cached = discoveryCache.get(issuer);
  if (cached && Date.now() - cached.fetchedAt < DISCOVERY_TTL_MS) {
    return cached.jwksUri;
  }

  // Build discovery URL (strip trailing slashes from issuer before appending).
  const normalizedIssuer = issuer.replace(/\/+$/, "");
  const discoveryUrl = `${normalizedIssuer}/.well-known/openid-configuration`;

  // Fetch the discovery document.
  let res: Response;
  let doc: unknown;
  try {
    res = await oidcFetch(discoveryUrl);
    doc = await res.json();
  } catch (err) {
    if (err instanceof OidcFetchError) {
      throw new OidcDiscoveryError(
        "discovery-unreachable",
        `Discovery fetch failed for issuer ${issuer}: ${err.message}`,
      );
    }
    // Any other error (network, JSON parse, etc.) → unreachable
    throw new OidcDiscoveryError(
      "discovery-unreachable",
      `Discovery fetch failed for issuer ${issuer}: ${String(err)}`,
    );
  }

  // Validate the document shape.
  if (
    typeof doc !== "object" ||
    doc === null ||
    !("issuer" in doc) ||
    !("jwks_uri" in doc)
  ) {
    throw new OidcDiscoveryError(
      "discovery-invalid",
      `Discovery doc for ${issuer} is not a valid JSON object with issuer/jwks_uri`,
    );
  }

  const docRecord = doc as Record<string, unknown>;

  // Issuer assertion per OIDC Discovery 1.0 §4.3.
  if (docRecord.issuer !== issuer) {
    throw new OidcDiscoveryError(
      "discovery-invalid",
      `Discovery doc issuer mismatch: got "${String(docRecord.issuer)}", expected "${issuer}"`,
    );
  }

  // Validate jwks_uri.
  const jwksUri = docRecord.jwks_uri;
  if (typeof jwksUri !== "string" || jwksUri === "") {
    throw new OidcDiscoveryError(
      "discovery-invalid",
      `Discovery doc for ${issuer} has missing or empty jwks_uri`,
    );
  }

  // Require https scheme.
  let parsedJwksUri: URL;
  try {
    parsedJwksUri = new URL(jwksUri);
  } catch {
    throw new OidcDiscoveryError(
      "discovery-invalid",
      `Discovery doc for ${issuer} has an unparseable jwks_uri: ${jwksUri}`,
    );
  }

  if (parsedJwksUri.protocol !== "https:") {
    throw new OidcDiscoveryError(
      "discovery-invalid",
      `Discovery doc for ${issuer} has non-https jwks_uri: ${jwksUri}`,
    );
  }

  // Security R-2/d2: block internal hosts in jwks_uri (defense-in-depth SSRF
  // guard at the discovery layer — the downstream verifyOidcJwt → oidcFetch
  // call will also re-check, but catching it here is the canonical close).
  if (isBlockedHost(parsedJwksUri.hostname)) {
    throw new OidcDiscoveryError(
      "discovery-invalid",
      `Discovery doc for ${issuer} has a blocked jwks_uri host: ${parsedJwksUri.hostname}`,
    );
  }

  // Cache and return.
  discoveryCache.set(issuer, { jwksUri, fetchedAt: Date.now() });
  return jwksUri;
}
