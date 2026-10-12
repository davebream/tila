/**
 * Canonicalization of worker_url for the anti-spoofing cross-check (WI-J2).
 *
 * The trust boundary compares a candidate's worker_url against the pinned
 * registry record's worker_url. That comparison is only sound if both sides are
 * canonicalized identically — otherwise trailing-slash, case, default-port,
 * userinfo, or IDN-homograph variants would bypass the check.
 */

/** Hosts for which a plaintext `http:` worker_url is tolerated (dev only). */
const LOCALHOST_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export class InvalidWorkerUrlError extends Error {
  readonly code = "INVALID_WORKER_URL" as const;

  constructor(message: string) {
    super(message);
    this.name = "InvalidWorkerUrlError";
  }
}

/**
 * Canonicalize a worker_url to a stable comparable string.
 *
 * Rules (all security-relevant):
 * - parse with the WHATWG `URL` API (rejects malformed input)
 * - reject any userinfo (`user:pass@host`) — a phishing vector
 * - require `https:` (allow `http:` only for localhost/loopback dev)
 * - lowercase scheme + host; IDN hosts are compared in punycode (`URL`
 *   normalizes `аcme` → `xn--...`), defeating homograph look-alikes
 * - strip the default port for the scheme, keep an explicit non-default port
 * - drop query + fragment; strip a single trailing slash from the path
 *
 * @throws InvalidWorkerUrlError on unparseable or disallowed input.
 */
export function canonicalizeWorkerUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new InvalidWorkerUrlError(`worker_url is not a valid URL: "${raw}"`);
  }

  if (url.username !== "" || url.password !== "") {
    throw new InvalidWorkerUrlError(
      `worker_url must not contain userinfo (user:pass@): "${raw}"`,
    );
  }

  const scheme = url.protocol.toLowerCase(); // includes trailing ":"
  const host = url.hostname.toLowerCase(); // punycode form for IDN
  const isLocalhost = LOCALHOST_HOSTS.has(host);
  if (scheme !== "https:" && !(scheme === "http:" && isLocalhost)) {
    throw new InvalidWorkerUrlError(
      `worker_url must use https (http allowed only for localhost): "${raw}"`,
    );
  }

  // url.host is host[:port] with the default port already stripped by URL.
  const hostPort = url.host.toLowerCase();
  let pathPart = url.pathname;
  if (pathPart.endsWith("/")) {
    pathPart = pathPart.slice(0, -1);
  }

  return `${scheme}//${hostPort}${pathPart}`;
}
