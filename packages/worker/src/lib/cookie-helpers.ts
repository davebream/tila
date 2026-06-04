import { COOKIE_SESSION_TTL_SECONDS } from "../config";

export function buildSessionCookie(value: string, isLocalDev: boolean): string {
  // SameSite=Lax is the CSRF mechanism under same-origin deployment (UI and API on the
  // same *.workers.dev / custom domain). Lax blocks cross-origin POST/PUT/DELETE but
  // allows top-level GET navigations — sufficient for the OAuth callback flow.
  //
  // Re-enabling cross-origin UI requires BOTH SameSite=None AND a non-empty
  // CORS_ALLOWED_ORIGINS allowlist; do not flip one without the other.
  //
  // For local dev (HTTP), Secure must be omitted because localhost is not HTTPS.
  if (isLocalDev) {
    return `tila_session=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${COOKIE_SESSION_TTL_SECONDS}`;
  }
  return `tila_session=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${COOKIE_SESSION_TTL_SECONDS}`;
}

export function isLocalhost(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return hostname === "localhost" || hostname === "127.0.0.1";
  } catch {
    return false;
  }
}
