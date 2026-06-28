/**
 * RFC 8414 OIDC / OAuth 2.0 Authorization Server Metadata discovery.
 *
 * `resolveOidcEndpoints` fetches the issuer's metadata document and validates:
 *   - The returned `issuer` field matches the configured issuer (issuer-confusion defense)
 *   - `device_authorization_endpoint` is present and uses https
 *   - `token_endpoint` is present and uses https
 *
 * Discovery is NOT persisted — `mint` re-discovers on every call so it is
 * fully restartable across retries without stale endpoint state.
 *
 * Fallback order (RFC 8414 §3):
 *   1. <issuer>/.well-known/openid-configuration   (OIDC)
 *   2. <issuer>/.well-known/oauth-authorization-server   (OAuth 2.0)
 *
 * Uses `oidcEgressFetch` for all outbound requests (https-only, timeout, size cap,
 * redirect rejection).
 *
 * JWKS is NOT fetched — CLI-side only needs device + token endpoints for device flow.
 * Token verification (JWKS) is server-side (WI-B2 / T3).
 */

import { OidcDiscoveryError } from "../errors.js";
import { oidcEgressFetch } from "./egress.js";

export interface OidcEndpoints {
  deviceAuthorizationEndpoint: string;
  tokenEndpoint: string;
  /** If the discovery doc includes a revocation_endpoint, returned here. */
  revocationEndpoint?: string;
}

interface DiscoveryDoc {
  issuer: string;
  device_authorization_endpoint?: string;
  token_endpoint?: string;
  revocation_endpoint?: string;
  [key: string]: unknown;
}

/**
 * Validate that an endpoint URL is present and uses https.
 */
function validateEndpointUrl(
  url: string | undefined,
  name: string,
  issuer: string,
): string {
  if (!url || typeof url !== "string") {
    throw new OidcDiscoveryError(
      `Discovery doc for issuer "${issuer}" is missing required field "${name}"`,
      "missing-endpoint",
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new OidcDiscoveryError(
      `Discovery doc for issuer "${issuer}": "${name}" is not a valid URL: ${url}`,
      "invalid-endpoint",
    );
  }

  if (parsed.protocol !== "https:") {
    throw new OidcDiscoveryError(
      `Discovery doc for issuer "${issuer}": "${name}" must use https (got: ${url})`,
      "invalid-endpoint",
    );
  }

  return url;
}

/**
 * Fetch and validate the discovery document from the given URL.
 * Returns the parsed document or null if the URL returned a non-2xx status
 * (which will cause the caller to try the fallback).
 *
 * Throws OidcDiscoveryError on network/egress errors that are not 404-class.
 */
async function fetchDiscoveryDoc(
  discoveryUrl: string,
  fetchFn: typeof globalThis.fetch,
): Promise<DiscoveryDoc | null> {
  try {
    const res = await oidcEgressFetch(discoveryUrl, undefined, fetchFn);
    return (await res.json()) as DiscoveryDoc;
  } catch (err) {
    // OidcEgressError with code "oidc-fetch-blocked" could be a non-2xx (e.g. 404).
    // We treat that as "not found here, try fallback".
    // Other errors (timeout, too-large) are propagated.
    if (
      err instanceof Error &&
      err.constructor.name === "OidcEgressError" &&
      (err as { code?: string }).code === "oidc-fetch-blocked"
    ) {
      return null;
    }
    throw err;
  }
}

/**
 * Resolve the OIDC device-flow endpoints for the given issuer via RFC 8414.
 *
 * Tries:
 *   1. <issuer>/.well-known/openid-configuration
 *   2. <issuer>/.well-known/oauth-authorization-server (fallback)
 *
 * Throws OidcDiscoveryError if:
 *   - Both discovery URLs fail
 *   - The returned `issuer` does not match the configured issuer
 *   - Required endpoints are missing or non-https
 */
export async function resolveOidcEndpoints(
  issuer: string,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): Promise<OidcEndpoints> {
  // Strip trailing slash from issuer for consistent URL construction.
  const base = issuer.replace(/\/$/, "");

  const primaryUrl = `${base}/.well-known/openid-configuration`;
  const fallbackUrl = `${base}/.well-known/oauth-authorization-server`;

  // Try primary, then fallback
  let doc: DiscoveryDoc | null = await fetchDiscoveryDoc(primaryUrl, fetchFn);

  if (doc === null) {
    doc = await fetchDiscoveryDoc(fallbackUrl, fetchFn);
  }

  if (doc === null) {
    throw new OidcDiscoveryError(
      `OIDC discovery failed for issuer "${issuer}": both /.well-known/openid-configuration and /.well-known/oauth-authorization-server returned errors`,
      "unreachable",
    );
  }

  // Issuer confusion defense: returned issuer MUST match configured issuer exactly.
  // Normalize trailing slashes for comparison.
  const returnedIssuer = String(doc.issuer ?? "").replace(/\/$/, "");
  const expectedIssuer = base;

  if (returnedIssuer !== expectedIssuer) {
    throw new OidcDiscoveryError(
      `OIDC issuer mismatch: configured "${issuer}", discovery returned "${doc.issuer}"`,
      "issuer-mismatch",
    );
  }

  // Validate required endpoints.
  const deviceAuthorizationEndpoint = validateEndpointUrl(
    doc.device_authorization_endpoint,
    "device_authorization_endpoint",
    issuer,
  );

  const tokenEndpoint = validateEndpointUrl(
    doc.token_endpoint,
    "token_endpoint",
    issuer,
  );

  // Revocation endpoint is optional.
  const revocationEndpoint =
    doc.revocation_endpoint && typeof doc.revocation_endpoint === "string"
      ? doc.revocation_endpoint
      : undefined;

  return {
    deviceAuthorizationEndpoint,
    tokenEndpoint,
    revocationEndpoint,
  };
}
