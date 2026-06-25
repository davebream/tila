import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OidcFetchError, isBlockedHost, oidcFetch } from "./oidc-fetch.js";

// ---------------------------------------------------------------------------
// Task 1: isBlockedHost truth table
// ---------------------------------------------------------------------------

describe("isBlockedHost", () => {
  describe("blocked — name-based", () => {
    it("blocks localhost", () => {
      expect(isBlockedHost("localhost")).toBe(true);
    });

    it("blocks .local suffix", () => {
      expect(isBlockedHost("foo.local")).toBe(true);
    });

    it("blocks .localhost suffix", () => {
      expect(isBlockedHost("foo.localhost")).toBe(true);
    });

    it("blocks .internal suffix", () => {
      expect(isBlockedHost("svc.internal")).toBe(true);
    });
  });

  describe("blocked — IPv4 literals", () => {
    it("blocks loopback 127.0.0.1", () => {
      expect(isBlockedHost("127.0.0.1")).toBe(true);
    });

    it("blocks RFC1918 10.x", () => {
      expect(isBlockedHost("10.0.0.5")).toBe(true);
    });

    it("blocks RFC1918 172.16.x", () => {
      expect(isBlockedHost("172.16.3.4")).toBe(true);
    });

    it("blocks RFC1918 192.168.x", () => {
      expect(isBlockedHost("192.168.1.1")).toBe(true);
    });

    it("blocks link-local 169.254.x", () => {
      expect(isBlockedHost("169.254.169.254")).toBe(true);
    });

    it("blocks unspecified 0.0.0.0", () => {
      expect(isBlockedHost("0.0.0.0")).toBe(true);
    });

    it("blocks CGNAT 100.64.0.1", () => {
      expect(isBlockedHost("100.64.0.1")).toBe(true);
    });
  });

  describe("allowed — public IPv4", () => {
    it("allows 8.8.8.8", () => {
      expect(isBlockedHost("8.8.8.8")).toBe(false);
    });

    it("allows 100.128.0.1 (outside CGNAT range)", () => {
      expect(isBlockedHost("100.128.0.1")).toBe(false);
    });
  });

  describe("blocked — IPv6 literals (bracketed)", () => {
    it("blocks loopback [::1]", () => {
      expect(isBlockedHost("[::1]")).toBe(true);
    });

    it("blocks link-local [fe80::1]", () => {
      expect(isBlockedHost("[fe80::1]")).toBe(true);
    });

    it("blocks unique-local [fc00::1]", () => {
      expect(isBlockedHost("[fc00::1]")).toBe(true);
    });

    it("blocks unspecified [::]", () => {
      expect(isBlockedHost("[::]")).toBe(true);
    });

    it("blocks IPv4-mapped dotted form [::ffff:127.0.0.1]", () => {
      expect(isBlockedHost("[::ffff:127.0.0.1]")).toBe(true);
    });

    it("blocks IPv4-mapped hex form [::ffff:7f00:1]", () => {
      expect(isBlockedHost("[::ffff:7f00:1]")).toBe(true);
    });

    it("blocks uppercase/zone-id variant [FE80::1%25eth0]", () => {
      expect(isBlockedHost("[FE80::1%25eth0]")).toBe(true);
    });
  });

  describe("allowed — public IPv6", () => {
    it("allows public v6 [2606:4700::1111]", () => {
      expect(isBlockedHost("[2606:4700::1111]")).toBe(false);
    });
  });

  describe("allowed — public DNS names", () => {
    it("allows token.actions.githubusercontent.com", () => {
      expect(isBlockedHost("token.actions.githubusercontent.com")).toBe(false);
    });

    it("allows example.com", () => {
      expect(isBlockedHost("example.com")).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// Task 2: oidcFetch behavior tests
// ---------------------------------------------------------------------------

describe("oidcFetch", () => {
  const JWKS_BODY = JSON.stringify({ keys: [{ kty: "RSA", kid: "k1" }] });
  const JWKS_URL =
    "https://token.actions.githubusercontent.com/.well-known/jwks";

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("(a) rejects non-https URLs with oidc-fetch-blocked", async () => {
    await expect(oidcFetch("http://example.com/jwks")).rejects.toMatchObject({
      code: "oidc-fetch-blocked",
    });
  });

  it("(a) rejects ftp:// URLs with oidc-fetch-blocked", async () => {
    await expect(oidcFetch("ftp://example.com/jwks")).rejects.toMatchObject({
      code: "oidc-fetch-blocked",
    });
  });

  it("(b) rejects blocked host without calling fetch", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    await expect(oidcFetch("https://127.0.0.1/jwks")).rejects.toMatchObject({
      code: "oidc-fetch-blocked",
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it("(c) throws oidc-fetch-timeout on never-resolving fetch", async () => {
    // The mock must respect the AbortSignal so the abort triggers the rejection.
    vi.spyOn(globalThis, "fetch").mockImplementation(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          const signal = (init as RequestInit | undefined)?.signal;
          if (signal) {
            signal.addEventListener("abort", () =>
              reject(
                new DOMException("The operation was aborted.", "AbortError"),
              ),
            );
          }
        }),
    );

    // Attach the rejection assertion synchronously BEFORE advancing timers so the
    // abort-driven rejection is never momentarily unhandled (avoids a leaked
    // PromiseRejectionHandledWarning that would erode this security suite's signal).
    const promise = oidcFetch(JWKS_URL, { timeoutMs: 1000 });
    const assertion = expect(promise).rejects.toMatchObject({
      code: "oidc-fetch-timeout",
    });
    await vi.advanceTimersByTimeAsync(1001);
    await assertion;
  });

  it("(d) throws oidc-fetch-blocked on opaque-redirect response", async () => {
    // Node/undici cannot construct a real opaque-redirect Response (status:0 throws).
    // Use the explicitly-carved-out typed stub for this branch only.
    const stub = {
      type: "opaqueredirect",
      status: 0,
      ok: false,
    } as unknown as Response;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(stub);

    await expect(oidcFetch(JWKS_URL)).rejects.toMatchObject({
      code: "oidc-fetch-blocked",
    });
  });

  it("(e) throws oidc-fetch-blocked on non-2xx response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("server error", { status: 500 }),
    );

    await expect(oidcFetch(JWKS_URL)).rejects.toMatchObject({
      code: "oidc-fetch-blocked",
    });
  });

  it("(f) throws oidc-fetch-too-large on over-cap Content-Length header", async () => {
    const maxBytes = 256 * 1024;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("x", {
        status: 200,
        headers: { "content-length": String(maxBytes + 1) },
      }),
    );

    await expect(oidcFetch(JWKS_URL)).rejects.toMatchObject({
      code: "oidc-fetch-too-large",
    });
  });

  it("(g) throws oidc-fetch-too-large when streamed body exceeds maxBytes", async () => {
    // Use a small maxBytes cap via OidcFetchInit so body doesn't need to be huge.
    const body = "123456789"; // 9 bytes
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(body, { status: 200 }),
    );

    await expect(oidcFetch(JWKS_URL, { maxBytes: 8 })).rejects.toMatchObject({
      code: "oidc-fetch-too-large",
    });
  });

  it("(h) happy path returns a json-able status-preserving Response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JWKS_BODY, {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const res = await oidcFetch(JWKS_URL);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({ keys: [{ kty: "RSA", kid: "k1" }] });
  });

  it("OidcFetchError is an instanceof Error", async () => {
    const err = await oidcFetch("http://insecure.example.com/jwks").catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(OidcFetchError);
  });
});
