/**
 * Hardened OIDC egress wrapper.
 *
 * `oidcFetch` is the only sanctioned network path for reaching OIDC issuer
 * endpoints (JWKS, discovery docs).  It enforces:
 *   - https-only scheme
 *   - SSRF host guard (IP literals + name deny-list)
 *   - AbortController timeout
 *   - Redirect rejection (redirect:"manual" → opaque-redirect detection)
 *   - Non-2xx upstream rejection
 *   - Streamed response size cap
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const OIDC_FETCH_TIMEOUT_MS = 5_000;
const OIDC_FETCH_MAX_BYTES = 256 * 1024; // 256 KiB

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

export type OidcFetchErrorCode =
  | "oidc-fetch-blocked"
  | "oidc-fetch-timeout"
  | "oidc-fetch-too-large";

export class OidcFetchError extends Error {
  readonly code: OidcFetchErrorCode;

  constructor(code: OidcFetchErrorCode, message: string) {
    super(`[${code}] ${message}`);
    this.name = "OidcFetchError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Extended init type
// ---------------------------------------------------------------------------

export type OidcFetchInit = RequestInit & {
  /** Timeout in milliseconds (default: 5000). */
  timeoutMs?: number;
  /** Maximum response body size in bytes (default: 256 KiB). */
  maxBytes?: number;
};

// ---------------------------------------------------------------------------
// SSRF host predicate
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
  // Normalize by expanding `::ffff:` prefix.
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
  // fe80 .. feb3 in the first 16 bits; the mask is 0xffc0 on the leading 16-bit group.
  const firstGroup = Number.parseInt(addr.split(":")[0] || "0", 16);
  if ((firstGroup & 0xffc0) === 0xfe80) return true;

  // Unique-local: fc00::/7  (first 7 bits = 1111 110)
  // Covers fc00::/8 and fd00::/8.
  if ((firstGroup & 0xfe00) === 0xfc00) return true;

  return false;
}

/**
 * Returns `true` if `host` (as extracted from a URL, e.g. `url.hostname`) should
 * be rejected as a potentially-internal target.
 *
 * Handles:
 * - Hostname deny-list: `localhost`, `*.local`, `*.localhost`, `*.internal`
 * - IPv4 literals: loopback, RFC1918, link-local, CGNAT, unspecified
 * - IPv6 literals (bracketed): loopback, link-local, unique-local, unspecified,
 *   IPv4-mapped (dotted and hex forms), zone-id suffix, upper/lower-case
 *
 * DNS rebinding (a hostname that resolves to a private IP) is a residual risk
 * that cannot be closed inside the Workers isolate — the issuer allowlist in
 * WI-B2 is the primary mitigation.
 */
export function isBlockedHost(host: string): boolean {
  // Strip surrounding brackets (IPv6 literal) and any zone-id suffix.
  let h = host;
  if (h.startsWith("[")) {
    h = h.slice(1, h.endsWith("]") ? -1 : h.length);
    // Strip zone-id: %25 or % followed by non-] chars
    const zoneIdx = h.indexOf("%");
    if (zoneIdx !== -1) h = h.slice(0, zoneIdx);
    // Now h is a raw IPv6 address — normalise to lowercase.
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
// oidcFetch — hardened egress wrapper
// ---------------------------------------------------------------------------

/**
 * Fetch a resource from an OIDC issuer endpoint with full hardening:
 * https-only, SSRF host guard, AbortController timeout, redirect rejection,
 * non-2xx rejection, and streamed size cap.
 *
 * Returns a reconstructed `Response` that preserves the upstream `status`,
 * `statusText`, and `Content-Type`, so the caller's `.json()` and `.ok` work.
 */
export async function oidcFetch(
  url: string,
  init?: OidcFetchInit,
): Promise<Response> {
  // 1. Parse URL and enforce https scheme.
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new OidcFetchError("oidc-fetch-blocked", `invalid URL: ${url}`);
  }

  if (parsed.protocol !== "https:") {
    throw new OidcFetchError(
      "oidc-fetch-blocked",
      `non-https scheme: ${parsed.protocol}`,
    );
  }

  // 2. SSRF host guard.
  if (isBlockedHost(parsed.hostname)) {
    throw new OidcFetchError(
      "oidc-fetch-blocked",
      `blocked host: ${parsed.hostname}`,
    );
  }

  const timeoutMs = init?.timeoutMs ?? OIDC_FETCH_TIMEOUT_MS;
  const maxBytes = init?.maxBytes ?? OIDC_FETCH_MAX_BYTES;

  // Strip our custom keys before forwarding to fetch.
  const { timeoutMs: _t, maxBytes: _m, ...fetchInit } = init ?? {};

  // 3. Fetch with AbortController timeout and redirect:"manual".
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetch(url, {
      ...fetchInit,
      signal: controller.signal,
      redirect: "manual",
    });
  } catch (err) {
    if (controller.signal.aborted) {
      throw new OidcFetchError(
        "oidc-fetch-timeout",
        `request timed out after ${timeoutMs}ms`,
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  // 3a. Redirect rejection — Workers-correct detection.
  // Under redirect:"manual" the runtime returns an opaque-redirect response
  // whose type === "opaqueredirect" and status === 0 (not a readable 3xx).
  if (res.type === "opaqueredirect" || res.redirected || res.status === 0) {
    throw new OidcFetchError("oidc-fetch-blocked", "redirect rejected");
  }

  // 4. Non-2xx rejection.
  if (!res.ok) {
    throw new OidcFetchError(
      "oidc-fetch-blocked",
      `upstream status ${res.status}`,
    );
  }

  // 5. Size cap — early rejection via Content-Length header.
  const contentLength = Number.parseInt(
    res.headers.get("content-length") ?? "",
    10,
  );
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new OidcFetchError(
      "oidc-fetch-too-large",
      `Content-Length ${contentLength} exceeds limit ${maxBytes}`,
    );
  }

  // 5a. Stream + accumulate with running-total size cap.
  const contentType = res.headers.get("content-type") ?? "";
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  if (res.body != null) {
    const reader = res.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          totalBytes += value.byteLength;
          if (totalBytes > maxBytes) {
            reader.cancel().catch(() => {});
            throw new OidcFetchError(
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
  }

  // Reconstruct a status- and Content-Type-preserving Response.
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  const headers = new Headers();
  if (contentType) headers.set("content-type", contentType);

  return new Response(bytes, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}
