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

  it("includes style-src with Google Fonts allowlist", () => {
    const headers = new Headers();
    addSecurityHeaders(headers);

    const csp = headers.get("Content-Security-Policy") ?? "";
    expect(csp).toContain(
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    );
    expect(csp).toContain("font-src 'self' https://fonts.gstatic.com");
  });

  it("includes upgrade-insecure-requests directive", () => {
    const headers = new Headers();
    addSecurityHeaders(headers);

    expect(headers.get("Content-Security-Policy")).toContain(
      "upgrade-insecure-requests",
    );
  });
});
