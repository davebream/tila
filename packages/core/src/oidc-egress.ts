/**
 * Hardened OIDC egress wrapper — the canonical shared implementation.
 *
 * `oidcEgressFetch` is the single sanctioned network path for reaching OIDC
 * issuer endpoints (discovery docs, JWKS, token endpoints). It is consumed by
 * both `@tila/worker` (`oidcFetch`, with the SSRF host-guard enabled) and
 * `@tila/auth-store` (`oidcEgressFetch`, host-guard omitted under its trusted
 * instance-registry threat model). Centralising it here means the security
 * invariants cannot drift between the two call sites (issue #153).
 *
 * Security invariants (enforced once, here):
 *   - https-only scheme (rejects http, ftp, … before any connection)
 *   - optional injectable SSRF host-guard, checked BEFORE any fetch call
 *   - redirect rejection: `redirect: "manual"` (never silently follows on any
 *     spec-compliant runtime) + a multi-signal post-hoc check covering the
 *     Workers opaque-redirect shape AND a raw 3xx, plus a belt-and-suspenders
 *     redirect-`TypeError` catch for non-spec-compliant runtimes
 *   - AbortController timeout (default 5s, configurable via `timeoutMs`)
 *   - non-2xx upstream rejection
 *   - response size cap (default 256 KiB, configurable via `maxBytes`) enforced
 *     via Content-Length, a streamed running-total, AND the text() fallback
 *
 * Platform note: this module uses only Web-standard APIs (`fetch`, `Response`,
 * `Headers`, `AbortController`, `ReadableStream`) — no Cloudflare-Workers types
 * — so it is safe for `@tila/core` and importable by both a Workers consumer
 * and a Bun/Node CLI consumer.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const OIDC_EGRESS_TIMEOUT_MS = 5_000;
export const OIDC_EGRESS_MAX_BYTES = 256 * 1024; // 256 KiB

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

export type OidcEgressErrorCode =
  | "oidc-fetch-blocked" // non-https, blocked host, redirect, non-2xx upstream
  | "oidc-fetch-timeout" // AbortController deadline exceeded
  | "oidc-fetch-too-large"; // Content-Length or streaming size cap exceeded

/**
 * Thrown by `oidcEgressFetch` when a request to an OIDC issuer endpoint is
 * rejected by the hardened egress wrapper. Carries a discriminable `code` so
 * callers can branch without string-matching the message.
 *
 * The literal class identifier `OidcEgressError` is load-bearing:
 * `@tila/auth-store`'s `oidc-discovery.ts` branches on
 * `err.constructor.name === "OidcEgressError"`. Do not rename the class.
 */
export class OidcEgressError extends Error {
  readonly code: OidcEgressErrorCode;

  constructor(code: OidcEgressErrorCode, message: string) {
    super(`[${code}] ${message}`);
    this.name = "OidcEgressError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Extended init + options
// ---------------------------------------------------------------------------

export type OidcEgressInit = RequestInit & {
  /** Timeout in milliseconds (default: 5000). */
  timeoutMs?: number;
  /** Maximum response body size in bytes (default: 256 KiB). */
  maxBytes?: number;
};

export type OidcEgressOptions = {
  /**
   * Injected fetch implementation (default: `globalThis.fetch`). The injection
   * point for tests; production callers can omit it. Resolved at call time so a
   * spy on `globalThis.fetch` is observed.
   */
  fetchFn?: typeof globalThis.fetch;
  /**
   * Optional SSRF host predicate. When supplied and it returns `true` for the
   * request hostname, the request is rejected as `oidc-fetch-blocked` BEFORE any
   * outbound connection. The worker passes `isBlockedHost` (enabled); auth-store
   * omits it (disabled, trusted-registry threat model).
   */
  hostGuard?: (host: string) => boolean;
};

// ---------------------------------------------------------------------------
// SSRF host predicate (moved verbatim from worker/oidc-fetch.ts)
// ---------------------------------------------------------------------------

/** Parse a dotted-quad IPv4 string into a 32-bit unsigned integer. */
function ipv4ToInt(addr: string): number {
  const parts = addr.split(".");
  if (parts.length !== 4) return Number.NaN;
  let val = 0;
  for (const part of parts) {
    const n = Number.parseInt(part, 10);
    if (Number.isNaN(n) || n < 0 || n > 255) return Number.NaN;
    val = (val << 8) | n;
  }
  return val >>> 0; // unsigned
}

/** Return true if the IPv4 address (as integer) falls in a blocked range. */
function isBlockedIpv4Int(v: number): boolean {
  if (Number.isNaN(v)) return false;
  // Loopback: 127.0.0.0/8
  if (v >>> 24 === 127) return true;
  // RFC1918: 10.0.0.0/8
  if (v >>> 24 === 10) return true;
  // RFC1918: 172.16.0.0/12
  if (v >>> 20 === (172 << 4) + 1) return true;
  // RFC1918: 192.168.0.0/16
  if (v >>> 16 === ((192 << 8) | 168)) return true;
  // Link-local: 169.254.0.0/16
  if (v >>> 16 === ((169 << 8) | 254)) return true;
  // CGNAT/shared: 100.64.0.0/10
  if (v >>> 22 === (100 << 2) + 1) return true;
  // Unspecified: 0.0.0.0/8
  if (v >>> 24 === 0) return true;
  return false;
}

/** Return true if the IPv6 hex-group address (already lowercased, no brackets, no zone) is blocked. */
function isBlockedIpv6(addr: string): boolean {
  // Unspecified ::
  if (addr === "::") return true;
  // Loopback ::1
  if (addr === "::1") return true;

  // Check for IPv4-mapped IPv6: ::ffff:<v4> in dotted or hex form.
  const mappedDotted = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(
    addr,
  );
  if (mappedDotted) {
    return isBlockedIpv4Int(ipv4ToInt(mappedDotted[1]));
  }

  // ::ffff:hhhh:hhhh  (hex groups, exactly two groups after ::ffff:)
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(addr);
  if (mappedHex) {
    const hi = Number.parseInt(mappedHex[1], 16);
    const lo = Number.parseInt(mappedHex[2], 16);
    const v4int = ((hi << 16) | lo) >>> 0;
    return isBlockedIpv4Int(v4int);
  }

  // Link-local: fe80::/10  (first 10 bits = 1111 1110 10)
  const firstGroup = Number.parseInt(addr.split(":")[0] || "0", 16);
  if ((firstGroup & 0xffc0) === 0xfe80) return true;

  // Unique-local: fc00::/7  (covers fc00::/8 and fd00::/8)
  if ((firstGroup & 0xfe00) === 0xfc00) return true;

  return false;
}

/**
 * Returns `true` if `host` (as extracted from a URL, e.g. `url.hostname`) should
 * be rejected as a potentially-internal target.
 *
 * Handles a hostname deny-list (`localhost`, `*.local`, `*.localhost`,
 * `*.internal`), IPv4 literals (loopback, RFC1918, link-local, CGNAT,
 * unspecified), and IPv6 literals (loopback, link-local, unique-local,
 * unspecified, IPv4-mapped dotted/hex forms, zone-id suffix, any case).
 *
 * DNS rebinding (a hostname that resolves to a private IP) is a residual risk
 * that cannot be closed inside the egress wrapper — the issuer allowlist (WI-B2)
 * is the primary mitigation.
 */
export function isBlockedHost(host: string): boolean {
  // Strip surrounding brackets (IPv6 literal) and any zone-id suffix.
  let h = host;
  if (h.startsWith("[")) {
    h = h.slice(1, h.endsWith("]") ? -1 : h.length);
    // Strip zone-id: %25 or % followed by non-] chars
    const zoneIdx = h.indexOf("%");
    if (zoneIdx !== -1) h = h.slice(0, zoneIdx);
    h = h.toLowerCase();
    return isBlockedIpv6(h);
  }

  h = h.toLowerCase();

  // Hostname deny-list.
  if (h === "localhost") return true;
  if (h.endsWith(".local")) return true;
  if (h.endsWith(".localhost")) return true;
  if (h.endsWith(".internal")) return true;

  // Try IPv4 literal.
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) {
    const v = ipv4ToInt(h);
    return isBlockedIpv4Int(v);
  }

  // Not an IP literal and not in the name deny-list → allowed.
  return false;
}

// ---------------------------------------------------------------------------
// oidcEgressFetch — hardened egress wrapper
// ---------------------------------------------------------------------------

/**
 * Fetch a resource from an OIDC issuer endpoint with full hardening:
 * https-only, optional SSRF host-guard, AbortController timeout, redirect
 * rejection, non-2xx rejection, and a size-capped body read.
 *
 * Returns a reconstructed `Response` that preserves the upstream `status`,
 * `statusText`, and `Content-Type`, so the caller's `.json()` and `.ok` work.
 *
 * @param url   - The HTTPS URL to fetch.
 * @param init  - Optional extended RequestInit (supports `timeoutMs` + `maxBytes`).
 * @param opts  - Optional `fetchFn` injection and `hostGuard` predicate.
 */
export async function oidcEgressFetch(
  url: string,
  init?: OidcEgressInit,
  opts?: OidcEgressOptions,
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

  // 2. Optional SSRF host guard — BEFORE any fetch call.
  if (opts?.hostGuard?.(parsed.hostname)) {
    throw new OidcEgressError(
      "oidc-fetch-blocked",
      `blocked host: ${parsed.hostname}`,
    );
  }

  const timeoutMs = init?.timeoutMs ?? OIDC_EGRESS_TIMEOUT_MS;
  const maxBytes = init?.maxBytes ?? OIDC_EGRESS_MAX_BYTES;

  // Strip our custom keys before forwarding to fetch.
  const { timeoutMs: _t, maxBytes: _m, ...baseInit } = init ?? {};

  const fetchFn = opts?.fetchFn ?? globalThis.fetch;

  // 3. Fetch with AbortController timeout and redirect:"manual".
  //    `redirect: "manual"` yields an opaque-redirect response on spec-compliant
  //    runtimes (Workers, Node/undici, Bun) and never silently follows. It is
  //    set here at request time and is NOT overridable by the caller.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetchFn(url, {
      ...baseInit,
      signal: controller.signal,
      redirect: "manual",
    });
  } catch (err) {
    if (controller.signal.aborted) {
      throw new OidcEgressError(
        "oidc-fetch-timeout",
        `request timed out after ${timeoutMs}ms`,
      );
    }
    // Belt-and-suspenders: a runtime that THROWS on redirect (rather than
    // returning an opaque response) surfaces a redirect-named TypeError. This is
    // NOT the primary redirect defense (the post-hoc check below is) — it only
    // catches non-spec-compliant runtimes.
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

  // 3a. Post-hoc redirect rejection — covers every runtime representation:
  //     opaque-redirect (Workers), res.redirected (all), status 0 (Workers
  //     opaque), and a readable raw 3xx (runtimes that return it instead).
  if (
    res.type === "opaqueredirect" ||
    res.redirected ||
    res.status === 0 ||
    (res.status >= 300 && res.status < 400)
  ) {
    throw new OidcEgressError("oidc-fetch-blocked", "redirect rejected");
  }

  // 4. Non-2xx rejection.
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

  // 6. Read response body, enforcing the size cap. BOTH paths are required:
  //    - streaming (res.body present): production path on real runtimes.
  //    - text() fallback (res.body == null): test doubles / non-streaming
  //      runtimes. Omitting it yields an empty body for those callers.
  const contentType = res.headers.get("content-type") ?? "";
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

    const bytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    bodyText = new TextDecoder().decode(bytes);
  } else {
    // body is null/undefined — fall back to text() (test doubles, older runtimes).
    bodyText = await res.text();
    // Enforce the size cap on the text length (approximate byte check; OIDC/JWKS
    // payloads are ASCII JSON, where length and byte count coincide).
    if (bodyText.length > maxBytes) {
      throw new OidcEgressError(
        "oidc-fetch-too-large",
        `response body exceeds limit ${maxBytes} bytes`,
      );
    }
  }

  // Reconstruct a status- and Content-Type-preserving Response from the body.
  const headers = new Headers();
  if (contentType) headers.set("content-type", contentType);

  return new Response(bodyText, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}
