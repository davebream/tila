import { describe, expect, it } from "vitest";
import { parseCookieHeader } from "./parse-cookie";

describe("parseCookieHeader", () => {
  it("extracts a single cookie by name", () => {
    expect(parseCookieHeader("session=abc123", "session")).toBe("abc123");
  });

  it("extracts the correct cookie from multiple cookies", () => {
    const header = "foo=bar; session=xyz789; baz=qux";
    expect(parseCookieHeader(header, "session")).toBe("xyz789");
  });

  it("decodes URL-encoded cookie values", () => {
    const header = "token=hello%20world";
    expect(parseCookieHeader(header, "token")).toBe("hello world");
  });

  it("returns null when the cookie name is not present", () => {
    expect(parseCookieHeader("foo=bar; baz=qux", "missing")).toBeNull();
  });

  it("returns null for an empty header string", () => {
    expect(parseCookieHeader("", "session")).toBeNull();
  });

  it("returns null for undefined header", () => {
    expect(parseCookieHeader(undefined, "session")).toBeNull();
  });

  it("handles a cookie value containing = (only first = is the delimiter)", () => {
    const header = "token=abc=def=ghi";
    expect(parseCookieHeader(header, "token")).toBe("abc=def=ghi");
  });

  it("does not match a cookie whose name is a substring of another cookie name", () => {
    const header = "tila_session=xyz; session=abc";
    expect(parseCookieHeader(header, "session")).toBe("abc");
  });

  it("does not match when the target name is a prefix of a cookie name", () => {
    const header = "tila_session=xyz";
    expect(parseCookieHeader(header, "tila")).toBeNull();
  });

  it("handles whitespace around separators gracefully", () => {
    const header = "  foo  =  bar  ;  session  =  tok  ";
    expect(parseCookieHeader(header, "session")).toBe("tok");
  });
});
