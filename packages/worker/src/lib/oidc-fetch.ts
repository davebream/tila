/**
 * Hardened OIDC egress wrapper (worker adapter).
 *
 * `oidcFetch` is the only sanctioned network path for reaching OIDC issuer
 * endpoints (JWKS, discovery docs) from the worker. It is a thin adapter over
 * the canonical shared wrapper in `@tila/core` (`oidcEgressFetch`) with the SSRF
 * host-guard enabled — the worker accepts operator-supplied issuer configs, so
 * `isBlockedHost` (IP literals + name deny-list) must reject internal targets.
 *
 * All hardening (https-only, redirect rejection, AbortController timeout,
 * non-2xx rejection, streamed size cap) lives in `@tila/core/oidc-egress`; this
 * module only wires in the host-guard and preserves the historical export names
 * so existing callers (`oidc-verify`, `oidc-discovery`) and tests are unchanged.
 *
 * @module
 */

import {
  OidcEgressError,
  type OidcEgressErrorCode,
  type OidcEgressInit,
  isBlockedHost,
  oidcEgressFetch,
} from "@tila/core";

// Re-export the shared SSRF host predicate and the canonical error class under
// the worker's historical names. `OidcEgressError as OidcFetchError` is the
// SAME class object, so `instanceof OidcFetchError` and `.code` keep working.
export { isBlockedHost };
export { OidcEgressError as OidcFetchError };
export type OidcFetchErrorCode = OidcEgressErrorCode;
export type OidcFetchInit = OidcEgressInit;

/**
 * Fetch a resource from an OIDC issuer endpoint with full hardening plus the
 * SSRF host guard. Delegates to the shared `@tila/core` egress wrapper.
 */
export async function oidcFetch(
  url: string,
  init?: OidcFetchInit,
): Promise<Response> {
  return oidcEgressFetch(url, init, { hostGuard: isBlockedHost });
}
