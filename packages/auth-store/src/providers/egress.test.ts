/**
 * Tests for the hardened OIDC egress wrapper (oidcEgressFetch).
 *
 * All tests are Bun+Node-agnostic — they do not rely on `response.type === "opaqueredirect"`.
 * The primary redirect guard is the `redirect: "error"` on the request init.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OidcEgressError } from "../errors.js";
import { oidcEgressFetch } from "./egress.js";
import { FakeFetch } from "./ports.js";

describe("oidcEgressFetch", () => {
  let ff: FakeFetch;

  beforeEach(() => {
    ff = new FakeFetch();
  });

  afterEach(() => {
    ff.assertExhausted();
  });

  describe("https-only enforcement", () => {
    it("rejects http:// URLs", async () => {
      await expect(
        oidcEgressFetch("http://example.com/api", undefined, ff.fetch),
      ).rejects.toThrow(OidcEgressError);
      await expect(
        oidcEgressFetch("http://example.com/api", undefined, ff.fetch),
      ).rejects.toMatchObject({ code: "oidc-fetch-blocked" });
    });

    it("rejects ftp:// URLs", async () => {
      await expect(
        oidcEgressFetch("ftp://example.com/file", undefined, ff.fetch),
      ).rejects.toThrow(OidcEgressError);
    });

    it("accepts https:// URLs", async () => {
      ff.pushJson(200, { ok: true });
      const res = await oidcEgressFetch(
        "https://example.com/api",
        undefined,
        ff.fetch,
      );
      expect(res.ok).toBe(true);
    });
  });

  describe("redirect rejection via request init", () => {
    it("sets redirect:'error' on the fetch init (CI-2: prevents outbound SSRF via redirect)", async () => {
      ff.pushJson(200, { data: "response" });
      await oidcEgressFetch("https://example.com/api", undefined, ff.fetch);

      // Assert that the fetch was called with redirect: "error" in the request init
      expect(ff.calls).toHaveLength(1);
      expect(ff.calls[0].init).toMatchObject({ redirect: "error" });
    });

    it("sets redirect:'error' even when caller provides custom init without redirect field", async () => {
      ff.pushJson(200, { data: "response" });
      await oidcEgressFetch(
        "https://example.com/api",
        { headers: { "Content-Type": "application/json" } },
        ff.fetch,
      );

      expect(ff.calls[0].init).toMatchObject({
        redirect: "error",
        headers: { "Content-Type": "application/json" },
      });
    });

    it("does not allow caller to override redirect to 'follow'", async () => {
      ff.pushJson(200, { data: "response" });
      await oidcEgressFetch(
        "https://example.com/api",
        // Caller tries to pass redirect: "follow" — must be overridden
        { redirect: "follow" } as RequestInit,
        ff.fetch,
      );

      // Should have used redirect: "error" not "follow"
      expect(ff.calls[0].init).toMatchObject({ redirect: "error" });
    });

    it("rejects when response.redirected is true (defense-in-depth post-hoc check)", async () => {
      // Simulate a FakeFetch response that has redirected: true
      const redirectedFetch: typeof globalThis.fetch = () => {
        const res = {
          ok: true,
          status: 200,
          statusText: "OK",
          redirected: true,
          headers: new Headers(),
          body: null,
          json: () => Promise.resolve({}),
          text: () => Promise.resolve("{}"),
        } as unknown as Response;
        return Promise.resolve(res);
      };

      await expect(
        oidcEgressFetch("https://example.com/api", undefined, redirectedFetch),
      ).rejects.toMatchObject({ code: "oidc-fetch-blocked" });
    });
  });

  describe("response size cap (default 256 KiB)", () => {
    it("rejects response with Content-Length header exceeding the cap", async () => {
      // 257 KiB > 256 KiB default cap
      const oversizeFetch: typeof globalThis.fetch = () => {
        const headers = new Headers();
        headers.set("content-length", String(257 * 1024));
        const res = {
          ok: true,
          status: 200,
          statusText: "OK",
          redirected: false,
          headers,
          body: null,
          json: () => Promise.resolve({}),
          text: () => Promise.resolve("{}"),
        } as unknown as Response;
        return Promise.resolve(res);
      };

      await expect(
        oidcEgressFetch("https://example.com/api", undefined, oversizeFetch),
      ).rejects.toMatchObject({ code: "oidc-fetch-too-large" });
    });

    it("accepts response within the size cap", async () => {
      ff.pushJson(200, { issuer: "https://example.com" });
      const res = await oidcEgressFetch(
        "https://example.com/.well-known/openid-configuration",
        undefined,
        ff.fetch,
      );
      expect(res.ok).toBe(true);
    });
  });

  describe("timeout", () => {
    it("rejects on timeout (AbortError)", async () => {
      // A fetch that never resolves until abort
      const timeoutFetch: typeof globalThis.fetch = (
        _input: RequestInfo | URL,
        init?: RequestInit,
      ): Promise<Response> => {
        return new Promise((_resolve, reject) => {
          // Listen for abort signal
          const signal = init?.signal as AbortSignal | undefined;
          if (signal) {
            if (signal.aborted) {
              const err = new DOMException(
                "The operation was aborted.",
                "AbortError",
              );
              reject(err);
              return;
            }
            signal.addEventListener("abort", () => {
              const err = new DOMException(
                "The operation was aborted.",
                "AbortError",
              );
              reject(err);
            });
          }
          // Never resolves on its own
        });
      };

      await expect(
        oidcEgressFetch(
          "https://example.com/api",
          { timeoutMs: 1 } as RequestInit & { timeoutMs?: number },
          timeoutFetch,
        ),
      ).rejects.toMatchObject({ code: "oidc-fetch-timeout" });
    });
  });

  describe("non-2xx upstream rejection", () => {
    it("rejects on 404", async () => {
      ff.pushJson(404, { error: "not found" });
      await expect(
        oidcEgressFetch("https://example.com/api", undefined, ff.fetch),
      ).rejects.toMatchObject({ code: "oidc-fetch-blocked" });
    });

    it("rejects on 500", async () => {
      ff.pushJson(500, { error: "server error" });
      await expect(
        oidcEgressFetch("https://example.com/api", undefined, ff.fetch),
      ).rejects.toMatchObject({ code: "oidc-fetch-blocked" });
    });
  });
});
