export function addSecurityHeaders(headers: Headers, nonce?: string): void {
  const cspDirectives = [
    "default-src 'self'",
    nonce ? `script-src 'nonce-${nonce}'` : "script-src 'self'",
    // The membership panel resolves a GitHub login to its numeric user id from
    // the browser via GitHub's public, CORS-enabled users endpoint (#102).
    "connect-src 'self' https://api.github.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "upgrade-insecure-requests",
  ].join("; ");

  headers.set("Content-Security-Policy", cspDirectives);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set("Permissions-Policy", "geolocation=(), camera=(), microphone=()");
}
