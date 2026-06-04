import { describe, expect, it } from "vitest";
import { buildSessionCookie, isLocalhost } from "./cookie-helpers";

describe("buildSessionCookie", () => {
  it("omits Secure flag when isLocalDev=true", () => {
    const cookie = buildSessionCookie("abc123", true);
    expect(cookie).not.toContain("Secure");
  });

  it("includes Secure flag when isLocalDev=false", () => {
    const cookie = buildSessionCookie("abc123", false);
    expect(cookie).toContain("Secure;");
  });

  it("always sets HttpOnly", () => {
    expect(buildSessionCookie("val", true)).toContain("HttpOnly;");
    expect(buildSessionCookie("val", false)).toContain("HttpOnly;");
  });

  it("sets SameSite=Lax when isLocalDev=true", () => {
    expect(buildSessionCookie("val", true)).toContain("SameSite=Lax");
    expect(buildSessionCookie("val", true)).not.toContain("SameSite=None");
    expect(buildSessionCookie("val", true)).not.toContain("SameSite=Strict");
  });

  it("sets SameSite=Lax when isLocalDev=false (same-origin prod)", () => {
    expect(buildSessionCookie("val", false)).toContain("SameSite=Lax");
    expect(buildSessionCookie("val", false)).not.toContain("SameSite=None");
    expect(buildSessionCookie("val", false)).not.toContain("SameSite=Strict");
  });

  it("sets the correct cookie name and value", () => {
    const cookie = buildSessionCookie("mytoken", true);
    expect(cookie.startsWith("tila_session=mytoken;")).toBe(true);
  });

  it("sets Path=/", () => {
    const cookie = buildSessionCookie("val", false);
    expect(cookie).toContain("Path=/");
  });

  it("sets Max-Age=28800", () => {
    const cookie = buildSessionCookie("val", false);
    expect(cookie).toContain("Max-Age=28800");
  });
});

describe("isLocalhost", () => {
  it("returns true for http://localhost", () => {
    expect(isLocalhost("http://localhost")).toBe(true);
  });

  it("returns true for http://localhost:8787", () => {
    expect(isLocalhost("http://localhost:8787")).toBe(true);
  });

  it("returns true for http://127.0.0.1", () => {
    expect(isLocalhost("http://127.0.0.1")).toBe(true);
  });

  it("returns true for http://127.0.0.1:8787", () => {
    expect(isLocalhost("http://127.0.0.1:8787")).toBe(true);
  });

  it("returns false for https://example.com", () => {
    expect(isLocalhost("https://example.com")).toBe(false);
  });

  it("returns false for https://localhost.example.com", () => {
    expect(isLocalhost("https://localhost.example.com")).toBe(false);
  });

  it("returns false for invalid URL strings", () => {
    expect(isLocalhost("not-a-url")).toBe(false);
    expect(isLocalhost("")).toBe(false);
    expect(isLocalhost("://broken")).toBe(false);
  });
});
