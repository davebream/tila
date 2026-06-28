/**
 * Hardened OIDC egress wrapper for @tila/auth-store (adapter).
 *
 * `oidcEgressFetch` is the only sanctioned network path for reaching OIDC
 * issuer endpoints (discovery docs, token endpoint) from the auth-store package.
 * It is a thin adapter over the canonical shared wrapper in `@tila/core`
 * (`oidcEgressFetch`), which enforces all security invariants — https-only,
 * redirect rejection (`redirect: "manual"` + multi-signal post-hoc detection),
 * AbortController timeout, response size cap, and non-2xx rejection.
 *
 * The SSRF host-guard is intentionally OMITTED here: auth-store's issuer comes
 * from the trusted instance registry (`~/.tila/instances.toml`), not untrusted
 * user input. If auth-store ever ingests untrusted issuer input, pass the
 * shared `hostGuard` option (the worker's `oidcFetch` does this today).
 *
 * The `fetchFn` injection parameter is preserved for tests. `@tila/core` is
 * platform-agnostic (no Workers types), so importing it here keeps auth-store
 * runnable on Bun/Node.
 */

import {
  OIDC_EGRESS_MAX_BYTES,
  OIDC_EGRESS_TIMEOUT_MS,
  type OidcEgressInit,
  oidcEgressFetch as coreOidcEgressFetch,
} from "@tila/core";

export { OIDC_EGRESS_TIMEOUT_MS, OIDC_EGRESS_MAX_BYTES };
export type { OidcEgressInit };

/**
 * Hardened fetch wrapper for OIDC issuer endpoints (host-guard disabled).
 *
 * @param url     - The HTTPS URL to fetch (must be https://).
 * @param init    - Optional extended RequestInit (supports timeoutMs + maxBytes).
 * @param fetchFn - Injected fetch implementation (default: globalThis.fetch).
 *                  Injection point for tests — production callers can omit this.
 */
export async function oidcEgressFetch(
  url: string,
  init?: OidcEgressInit,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): Promise<Response> {
  return coreOidcEgressFetch(url, init, { fetchFn });
}
