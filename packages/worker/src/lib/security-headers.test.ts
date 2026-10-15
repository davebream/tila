import { describe, expect, it } from "vitest";
import { addSecurityHeaders } from "./security-headers";

describe("addSecurityHeaders", () => {
  it("sets all required security headers", () => {
    const headers = new Headers();
    addSecurityHeaders(headers);

    expect(headers.get("Content-Security-Policy")).toContain(
      "default-src 'self'",
    );
    expect(headers.get("Content-Security-Policy")).toContain(
      "script-src 'self'",
    );
    expect(headers.get("Content-Security-Policy")).toContain(
      "object-src 'none'",
    );
    expect(headers.get("Content-Security-Policy")).toContain(
      "frame-ancestors 'none'",
    );
    expect(headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(headers.get("X-Frame-Options")).toBe("DENY");
    expect(headers.get("Referrer-Policy")).toBe(
      "strict-origin-when-cross-origin",
    );
    expect(headers.get("Permissions-Policy")).toBe(
      "geolocation=(), camera=(), microphone=()",
    );
  });

  it("uses nonce for script-src when provided", () => {
    const headers = new Headers();
    addSecurityHeaders(headers, "abc123");

    expect(headers.get("Content-Security-Policy")).toContain(
      "script-src 'nonce-abc123'",
    );
  });

  it("allows styles and fonts from the same origin only", () => {
    const headers = new Headers();
    addSecurityHeaders(headers);

    // Compare whole directives: a prefix match would still pass if an origin
    // were appended to style-src or font-src.
    const csp = headers.get("Content-Security-Policy") ?? "";
    const directives = csp.split("; ");
    expect(directives).toContain("style-src 'self' 'unsafe-inline'");
    expect(directives).toContain("font-src 'self'");
    expect(csp).not.toContain("fonts.googleapis.com");
    expect(csp).not.toContain("fonts.gstatic.com");
  });

  it("emits exactly the expected directives", () => {
    const headers = new Headers();
    addSecurityHeaders(headers);

    const csp = headers.get("Content-Security-Policy") ?? "";
    expect(csp.split("; ")).toEqual([
      "default-src 'self'",
      "script-src 'self'",
      "connect-src 'self' https://api.github.com",
      "style-src 'self' 'unsafe-inline'",
      "font-src 'self'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "upgrade-insecure-requests",
    ]);
  });

  it("allows browser calls to the GitHub public API for user lookup", () => {
    const headers = new Headers();
    addSecurityHeaders(headers);

    expect(headers.get("Content-Security-Policy")).toContain(
      "connect-src 'self' https://api.github.com",
    );
  });

  it("includes upgrade-insecure-requests directive", () => {
    const headers = new Headers();
    addSecurityHeaders(headers);

    expect(headers.get("Content-Security-Policy")).toContain(
      "upgrade-insecure-requests",
    );
  });
});
