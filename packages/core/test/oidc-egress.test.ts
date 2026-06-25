import { describe, expect, it, vi } from "vitest";
import {
  OIDC_EGRESS_MAX_BYTES,
  OIDC_EGRESS_TIMEOUT_MS,
  OidcEgressError,
  isBlockedHost,
  oidcEgressFetch,
} from "../src/oidc-egress";

// ---------------------------------------------------------------------------
// Fake response builders (the established auth-store seam: inject a fetchFn that
// returns response-like objects). Streaming path uses a real ReadableStream;
// the non-streaming path omits `body` (=== undefined) and supplies text().
// ---------------------------------------------------------------------------

type FakeInit = { headers?: Record<string, string> };

function jsonStreamResponse(json: unknown, init: FakeInit = {}): Response {
  const bodyText = JSON.stringify(json);
  const bytes = new TextEncoder().encode(bodyText);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    type: "basic",
    redirected: false,
    body,
    headers: new Headers({
      "content-type": "application/json",
      ...(init.headers ?? {}),
    }),
    text: async () => bodyText,
  } as unknown as Response;
}

// No `body` key → res.body === undefined → loose `!= null` routes to text().
function jsonTextOnlyResponse(json: unknown, init: FakeInit = {}): Response {
  const bodyText = JSON.stringify(json);
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    type: "basic",
    redirected: false,
    headers: new Headers({
      "content-type": "application/json",
      ...(init.headers ?? {}),
    }),
    text: async () => bodyText,
  } as unknown as Response;
}

function bareResponse(over: Partial<Record<string, unknown>>): Response {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    type: "basic",
    redirected: false,
    headers: new Headers(),
    text: async () => "",
    ...over,
  } as unknown as Response;
}

const fetchOf = (res: Response): typeof globalThis.fetch =>
  (async () => res) as unknown as typeof globalThis.fetch;

describe("oidc-egress constants", () => {
  it("exports the documented defaults", () => {
    expect(OIDC_EGRESS_TIMEOUT_MS).toBe(5_000);
    expect(OIDC_EGRESS_MAX_BYTES).toBe(256 * 1024);
  });
});

describe("OidcEgressError", () => {
  it("keeps the literal class identifier (oidc-discovery branches on constructor.name)", () => {
    const err = new OidcEgressError("oidc-fetch-blocked", "x");
    expect(err.constructor.name).toBe("OidcEgressError");
    expect(err.name).toBe("OidcEgressError");
    expect(err.code).toBe("oidc-fetch-blocked");
  });
});

describe("oidcEgressFetch — scheme + URL", () => {
  it("rejects an invalid URL as oidc-fetch-blocked", async () => {
    const spy = vi.fn();
    await expect(
      oidcEgressFetch("not a url", undefined, {
        fetchFn: spy as unknown as typeof globalThis.fetch,
      }),
    ).rejects.toMatchObject({ code: "oidc-fetch-blocked" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("rejects a non-https scheme as oidc-fetch-blocked before fetching", async () => {
    const spy = vi.fn();
    await expect(
      oidcEgressFetch("http://example.com/", undefined, {
        fetchFn: spy as unknown as typeof globalThis.fetch,
      }),
    ).rejects.toMatchObject({ code: "oidc-fetch-blocked" });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("oidcEgressFetch — host guard (injectable)", () => {
  it("with hostGuard enabled, rejects a blocked host WITHOUT calling fetch", async () => {
    const spy = vi.fn();
    await expect(
      oidcEgressFetch("https://127.0.0.1/x", undefined, {
        hostGuard: isBlockedHost,
        fetchFn: spy as unknown as typeof globalThis.fetch,
      }),
    ).rejects.toMatchObject({ code: "oidc-fetch-blocked" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("with hostGuard omitted, a blocked-looking host is allowed through to fetch", async () => {
    const res = jsonTextOnlyResponse({ ok: true });
    const spy = vi.fn(fetchOf(res));
    const out = await oidcEgressFetch("https://127.0.0.1/x", undefined, {
      fetchFn: spy as unknown as typeof globalThis.fetch,
    });
    expect(spy).toHaveBeenCalledTimes(1);
    await expect(out.json()).resolves.toEqual({ ok: true });
  });
});

describe("isBlockedHost — truth table parity", () => {
  it("blocks loopback / RFC1918 / link-local / CGNAT / unspecified IPv4", () => {
    expect(isBlockedHost("127.0.0.1")).toBe(true);
    expect(isBlockedHost("10.0.0.5")).toBe(true);
    expect(isBlockedHost("172.16.3.4")).toBe(true);
    expect(isBlockedHost("192.168.1.1")).toBe(true);
    expect(isBlockedHost("169.254.169.254")).toBe(true);
    expect(isBlockedHost("100.64.0.1")).toBe(true);
    expect(isBlockedHost("0.0.0.0")).toBe(true);
  });
  it("blocks localhost / .local / .localhost / .internal", () => {
    expect(isBlockedHost("localhost")).toBe(true);
    expect(isBlockedHost("foo.local")).toBe(true);
    expect(isBlockedHost("foo.localhost")).toBe(true);
    expect(isBlockedHost("svc.internal")).toBe(true);
  });
  it("blocks IPv6 loopback / link-local / unique-local / unspecified / mapped", () => {
    expect(isBlockedHost("[::1]")).toBe(true);
    expect(isBlockedHost("[fe80::1]")).toBe(true);
    expect(isBlockedHost("[fc00::1]")).toBe(true);
    expect(isBlockedHost("[::]")).toBe(true);
    expect(isBlockedHost("[::ffff:127.0.0.1]")).toBe(true);
    expect(isBlockedHost("[::ffff:7f00:1]")).toBe(true);
    expect(isBlockedHost("[FE80::1%25eth0]")).toBe(true);
  });
  it("allows public hosts", () => {
    expect(isBlockedHost("8.8.8.8")).toBe(false);
    expect(isBlockedHost("100.128.0.1")).toBe(false);
    expect(isBlockedHost("[2606:4700::1111]")).toBe(false);
    expect(isBlockedHost("token.actions.githubusercontent.com")).toBe(false);
  });
});

describe("oidcEgressFetch — redirect rejection (all runtime signals)", () => {
  it("rejects opaqueredirect (Workers manual-redirect)", async () => {
    await expect(
      oidcEgressFetch("https://issuer.example/x", undefined, {
        fetchFn: fetchOf(
          bareResponse({ type: "opaqueredirect", status: 0, ok: false }),
        ),
      }),
    ).rejects.toMatchObject({ code: "oidc-fetch-blocked" });
  });
  it("rejects res.redirected === true", async () => {
    await expect(
      oidcEgressFetch("https://issuer.example/x", undefined, {
        fetchFn: fetchOf(bareResponse({ redirected: true })),
      }),
    ).rejects.toMatchObject({ code: "oidc-fetch-blocked" });
  });
  it("rejects status === 0", async () => {
    await expect(
      oidcEgressFetch("https://issuer.example/x", undefined, {
        fetchFn: fetchOf(bareResponse({ status: 0, ok: false })),
      }),
    ).rejects.toMatchObject({ code: "oidc-fetch-blocked" });
  });
  it("rejects a raw 3xx status", async () => {
    await expect(
      oidcEgressFetch("https://issuer.example/x", undefined, {
        fetchFn: fetchOf(bareResponse({ status: 301, ok: false })),
      }),
    ).rejects.toMatchObject({ code: "oidc-fetch-blocked" });
  });
  it("maps a redirect-named TypeError to oidc-fetch-blocked", async () => {
    const fetchFn = (async () => {
      throw new TypeError("unexpected redirect encountered");
    }) as unknown as typeof globalThis.fetch;
    await expect(
      oidcEgressFetch("https://issuer.example/x", undefined, { fetchFn }),
    ).rejects.toMatchObject({ code: "oidc-fetch-blocked" });
  });
});

describe("oidcEgressFetch — timeout / non-2xx", () => {
  it("maps an abort to oidc-fetch-timeout", async () => {
    const fetchFn = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const e = new Error("aborted");
          e.name = "AbortError";
          reject(e);
        });
      })) as unknown as typeof globalThis.fetch;
    await expect(
      oidcEgressFetch(
        "https://issuer.example/x",
        { timeoutMs: 10 },
        { fetchFn },
      ),
    ).rejects.toMatchObject({ code: "oidc-fetch-timeout" });
  });
  it("rejects non-2xx upstream as oidc-fetch-blocked", async () => {
    await expect(
      oidcEgressFetch("https://issuer.example/x", undefined, {
        fetchFn: fetchOf(bareResponse({ ok: false, status: 500 })),
      }),
    ).rejects.toMatchObject({ code: "oidc-fetch-blocked" });
  });
});

describe("oidcEgressFetch — size cap", () => {
  it("rejects via Content-Length over maxBytes", async () => {
    await expect(
      oidcEgressFetch(
        "https://issuer.example/x",
        { maxBytes: 8 },
        {
          fetchFn: fetchOf(
            jsonTextOnlyResponse(
              { padding: "xxxxxxxxxxxxxxxx" },
              { headers: { "content-length": "100" } },
            ),
          ),
        },
      ),
    ).rejects.toMatchObject({ code: "oidc-fetch-too-large" });
  });
  it("rejects via streamed running-total over maxBytes (no content-length)", async () => {
    await expect(
      oidcEgressFetch(
        "https://issuer.example/x",
        { maxBytes: 4 },
        { fetchFn: fetchOf(jsonStreamResponse({ a: "bbbbbbbb" })) },
      ),
    ).rejects.toMatchObject({ code: "oidc-fetch-too-large" });
  });
  it("rejects via text() fallback over maxBytes (no body, no content-length)", async () => {
    // body == null path: no content-length header to short-circuit, so the
    // size cap must be re-applied on the decoded text length.
    await expect(
      oidcEgressFetch(
        "https://issuer.example/x",
        { maxBytes: 4 },
        { fetchFn: fetchOf(jsonTextOnlyResponse({ a: "bbbbbbbbbbbbbbbb" })) },
      ),
    ).rejects.toMatchObject({ code: "oidc-fetch-too-large" });
  });
});

describe("oidcEgressFetch — body reconstruction (both paths)", () => {
  it("streaming body → reconstructed .json() works", async () => {
    const out = await oidcEgressFetch("https://issuer.example/x", undefined, {
      fetchFn: fetchOf(jsonStreamResponse({ hello: "stream" })),
    });
    expect(out.status).toBe(200);
    await expect(out.json()).resolves.toEqual({ hello: "stream" });
  });
  it("non-streaming (body == null) fallback → reconstructed .json() works", async () => {
    const out = await oidcEgressFetch("https://issuer.example/x", undefined, {
      fetchFn: fetchOf(jsonTextOnlyResponse({ hello: "text" })),
    });
    expect(out.status).toBe(200);
    await expect(out.json()).resolves.toEqual({ hello: "text" });
  });
});
