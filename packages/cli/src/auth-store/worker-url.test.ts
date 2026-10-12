import { describe, expect, it } from "vitest";
import { InvalidWorkerUrlError, canonicalizeWorkerUrl } from "./worker-url.js";

describe("canonicalizeWorkerUrl", () => {
  it("strips a trailing slash", () => {
    expect(canonicalizeWorkerUrl("https://acme.dev/")).toBe("https://acme.dev");
    expect(canonicalizeWorkerUrl("https://acme.dev/api/")).toBe(
      "https://acme.dev/api",
    );
  });

  it("lowercases scheme and host", () => {
    expect(canonicalizeWorkerUrl("HTTPS://ACME.DEV")).toBe("https://acme.dev");
  });

  it("strips the default https port but keeps a non-default port", () => {
    expect(canonicalizeWorkerUrl("https://acme.dev:443")).toBe(
      "https://acme.dev",
    );
    expect(canonicalizeWorkerUrl("https://acme.dev:8787")).toBe(
      "https://acme.dev:8787",
    );
  });

  it("treats slash and case and default-port variants as equal", () => {
    const a = canonicalizeWorkerUrl("https://Acme.dev:443/");
    const b = canonicalizeWorkerUrl("https://acme.dev");
    expect(a).toBe(b);
  });

  it("rejects http for non-localhost hosts", () => {
    expect(() => canonicalizeWorkerUrl("http://acme.dev")).toThrow(
      InvalidWorkerUrlError,
    );
  });

  it("allows http only for localhost / loopback", () => {
    expect(canonicalizeWorkerUrl("http://localhost:8787")).toBe(
      "http://localhost:8787",
    );
    expect(canonicalizeWorkerUrl("http://127.0.0.1:8787")).toBe(
      "http://127.0.0.1:8787",
    );
  });

  it("rejects userinfo (phishing vector)", () => {
    expect(() => canonicalizeWorkerUrl("https://user:pass@acme.dev")).toThrow(
      InvalidWorkerUrlError,
    );
    expect(() => canonicalizeWorkerUrl("https://evil@acme.dev")).toThrow(
      InvalidWorkerUrlError,
    );
  });

  it("distinguishes an IDN homograph host from its ASCII look-alike (punycode)", () => {
    // "аcme.dev" with a Cyrillic 'а' (U+0430) must not canonicalize to "acme.dev".
    const homograph = canonicalizeWorkerUrl("https://аcme.dev");
    const ascii = canonicalizeWorkerUrl("https://acme.dev");
    expect(homograph).not.toBe(ascii);
    expect(homograph).toContain("xn--");
  });

  it("drops query and fragment", () => {
    expect(canonicalizeWorkerUrl("https://acme.dev/api?x=1#frag")).toBe(
      "https://acme.dev/api",
    );
  });

  it("throws on unparseable input", () => {
    expect(() => canonicalizeWorkerUrl("not a url")).toThrow(
      InvalidWorkerUrlError,
    );
  });
});
