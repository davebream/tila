/**
 * DPoP (RFC 9449) shared helpers — pure, platform-agnostic.
 * Imported by both the Worker verifier and the CLI signer so client and server
 * produce byte-identical htu values.
 *
 * NO jose, NO Workers types, NO Node.js APIs — this module runs everywhere.
 */

/** Required `typ` value in a DPoP proof JWT header (RFC 9449 §4.2). */
export const DPOP_TYP = "dpop+jwt" as const;

/** Required `alg` value in a DPoP proof JWT header. */
export const DPOP_ALG = "ES256" as const;

/**
 * Canonicalize a URL for use as the `htu` claim in a DPoP proof (RFC 9449 §4.3).
 *
 * Algorithm (pinned — client and server MUST use this identical function):
 *   1. Lowercase the scheme.
 *   2. Lowercase the host.
 *   3. Drop the default port: 443 for https, 80 for http.
 *   4. Keep the exact path (no trailing-slash normalization).
 *   5. Drop query string and fragment.
 *
 * @param url - Absolute URL string (e.g. from `c.req.url` on the server or
 *              the dialed URL on the client).
 * @returns The canonical htu string.
 */
export function canonicalizeHtu(url: string): string {
  const parsed = new URL(url);

  const scheme = parsed.protocol.replace(/:$/, "").toLowerCase();
  const host = parsed.hostname.toLowerCase();
  const port = parsed.port;

  let authority = host;
  if (port !== "") {
    const portNum = Number.parseInt(port, 10);
    const isDefault =
      (scheme === "https" && portNum === 443) ||
      (scheme === "http" && portNum === 80);
    if (!isDefault) {
      authority = `${host}:${port}`;
    }
  }

  // pathname already excludes query + fragment in the URL object
  const path = parsed.pathname;

  return `${scheme}://${authority}${path}`;
}
