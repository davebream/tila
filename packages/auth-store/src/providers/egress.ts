/**
 * Hardened OIDC egress wrapper for @tila/auth-store.
 *
 * `oidcEgressFetch` is the only sanctioned network path for reaching OIDC
 * issuer endpoints (discovery docs, token endpoint) from the auth-store package.
 *
 * Security invariants:
 *   - https-only scheme (rejects http, ftp, etc.)
 *   - redirect: "error" set ON THE REQUEST INIT so a redirect never opens an
 *     outbound connection (CI-2 — primary SSRF/open-redirect defense)
 *   - post-hoc response.redirected === false check (defense-in-depth)
 *   - AbortController timeout (default 5s, configurable via timeoutMs option)
 *   - Response size cap (default 256 KiB, configurable via maxBytes option)
 *   - Non-2xx upstream rejection
 *
 * NOTE: This module does NOT import from worker-runtime packages. It is used
 * by @tila/auth-store which runs on Bun/Node (CLI), not on Cloudflare Workers.
 *
 * Follow-up: converge this module with packages/worker/src/lib/oidc-fetch.ts.
 * The worker adds SSRF host-guard (IP literals + deny-list) that is not present
 * here because the CLI is not exposed to untrusted user-supplied issuer URLs in
 * the same threat model (issuer comes from the trusted instance registry).
 * Tracked: see the follow-up issue reference below.
 *
 * Follow-up issue: converge with packages/worker/src/lib/oidc-fetch.ts
 * Tracked at: https://github.com/davebream/tila/issues/153
 */

import { OidcEgressError } from "../errors.js";

export const OIDC_EGRESS_TIMEOUT_MS = 5_000;
export const OIDC_EGRESS_MAX_BYTES = 256 * 1024; // 256 KiB

export type OidcEgressInit = RequestInit & {
  /** Timeout in milliseconds (default: 5000). */
  timeoutMs?: number;
  /** Maximum response body size in bytes (default: 256 KiB). */
  maxBytes?: number;
};

/**
 * Hardened fetch wrapper for OIDC issuer endpoints.
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
  // 1. Parse URL and enforce https scheme.
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new OidcEgressError("oidc-fetch-blocked", `invalid URL: ${url}`);
  }

  if (parsed.protocol !== "https:") {
    throw new OidcEgressError(
      "oidc-fetch-blocked",
      `non-https scheme rejected: ${parsed.protocol} (only https is allowed)`,
    );
  }

  const timeoutMs =
    (init as OidcEgressInit | undefined)?.timeoutMs ?? OIDC_EGRESS_TIMEOUT_MS;
  const maxBytes =
    (init as OidcEgressInit | undefined)?.maxBytes ?? OIDC_EGRESS_MAX_BYTES;

  // Strip our custom keys before forwarding to fetch.
  const {
    timeoutMs: _t,
    maxBytes: _m,
    ...baseInit
  } = (init ?? {}) as OidcEgressInit;

  // 2. Fetch with:
  //    - redirect: "error" set on the REQUEST INIT (CI-2 primary defense)
  //      This instructs the runtime to reject any redirect attempt before
  //      it opens a new outbound connection. Both Bun and Node follow
  //      redirects by default, so we must set this at request time.
  //    - AbortController timeout
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetchFn(url, {
      ...baseInit,
      signal: controller.signal,
      // CI-2: redirect: "error" is set here at request time (NOT overridable by caller).
      // A redirect will cause the runtime to throw a TypeError before any outbound
      // connection is opened to the redirect target. The caller cannot bypass this
      // by passing redirect: "follow" in init — we always override it here.
      redirect: "error",
    });
  } catch (err) {
    if (controller.signal.aborted) {
      throw new OidcEgressError(
        "oidc-fetch-timeout",
        `request timed out after ${timeoutMs}ms`,
      );
    }
    // redirect: "error" causes a TypeError on redirect — propagate as blocked
    if (
      err instanceof TypeError &&
      err.message.toLowerCase().includes("redirect")
    ) {
      throw new OidcEgressError("oidc-fetch-blocked", "redirect rejected");
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  // 3. Defense-in-depth: post-hoc redirect check.
  // Even though redirect: "error" is the primary guard, some runtimes or polyfills
  // may not honor it correctly. response.redirected === true is a secondary signal.
  if (res.redirected) {
    throw new OidcEgressError(
      "oidc-fetch-blocked",
      "redirect rejected (post-hoc)",
    );
  }

  // 4. Non-2xx upstream rejection.
  if (!res.ok) {
    throw new OidcEgressError(
      "oidc-fetch-blocked",
      `upstream returned status ${res.status}`,
    );
  }

  // 5. Size cap — early rejection via Content-Length header.
  const contentLengthHeader = res.headers.get("content-length");
  if (contentLengthHeader !== null) {
    const contentLength = Number.parseInt(contentLengthHeader, 10);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      throw new OidcEgressError(
        "oidc-fetch-too-large",
        `Content-Length ${contentLength} exceeds limit ${maxBytes}`,
      );
    }
  }

  // 6. Read response body, enforcing the size cap.
  const contentType = res.headers.get("content-type") ?? "";

  // Use streaming when a ReadableStream body is available (production path).
  // Fall back to text() when body is null (test fakes or non-streaming environments).
  let bodyText: string;

  if (res.body != null) {
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;

    const reader = res.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          totalBytes += value.byteLength;
          if (totalBytes > maxBytes) {
            reader.cancel().catch(() => {});
            throw new OidcEgressError(
              "oidc-fetch-too-large",
              `response body exceeds limit ${maxBytes} bytes`,
            );
          }
          chunks.push(value);
        }
      }
    } finally {
      reader.releaseLock();
    }

    // Reconstruct body text from chunks.
    const bytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    bodyText = new TextDecoder().decode(bytes);
  } else {
    // body is null — fall back to text() (test fakes, older runtimes).
    bodyText = await res.text();

    // Enforce size cap on the text length (approximate byte check).
    if (bodyText.length > maxBytes) {
      throw new OidcEgressError(
        "oidc-fetch-too-large",
        `response body exceeds limit ${maxBytes} bytes`,
      );
    }
  }

  // Reconstruct a status- and Content-Type-preserving Response from the buffered body.
  const headers = new Headers();
  if (contentType) headers.set("content-type", contentType);

  return new Response(bodyText, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}
