import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock oidc-fetch module BEFORE importing oidc-discovery
// Note: vi.mock is hoisted so we must use vi.fn() inside the factory without
// referencing variables defined in the test file's outer scope.
vi.mock("./oidc-fetch", () => {
  class OidcFetchError extends Error {
    readonly code: string;
    constructor(code: string, message: string) {
      super(`[${code}] ${message}`);
      this.name = "OidcFetchError";
      this.code = code;
    }
  }

  return {
    oidcFetch: vi.fn(),
    OidcFetchError,
    isBlockedHost: vi.fn().mockReturnValue(false),
  };
});

import {
  OidcDiscoveryError,
  clearDiscoveryCacheForTesting,
  resolveJwksUri,
} from "./oidc-discovery";
import { OidcFetchError, isBlockedHost, oidcFetch } from "./oidc-fetch";

const mockOidcFetch = vi.mocked(oidcFetch);
const mockIsBlockedHost = vi.mocked(isBlockedHost);

/** Helper to make oidcFetch return a successful JSON response. */
function makeDiscoveryResponse(doc: Record<string, unknown>): Response {
  return new Response(JSON.stringify(doc), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** Helper to make a blocked OidcFetchError. */
function makeOidcFetchError(code = "oidc-fetch-blocked", msg = "blocked") {
  return new OidcFetchError(code as "oidc-fetch-blocked", msg);
}

describe("resolveJwksUri", () => {
  beforeEach(() => {
    clearDiscoveryCacheForTesting();
    mockOidcFetch.mockReset();
    mockIsBlockedHost.mockReset();
    mockIsBlockedHost.mockReturnValue(false);
  });

  afterEach(() => {
    clearDiscoveryCacheForTesting();
  });

  // (a) Happy path
  it("returns jwks_uri from a valid discovery doc", async () => {
    const issuer = "https://idp.example.com";
    mockOidcFetch.mockResolvedValue(
      makeDiscoveryResponse({
        issuer,
        jwks_uri: "https://idp.example.com/keys",
      }),
    );

    const result = await resolveJwksUri(issuer);
    expect(result).toBe("https://idp.example.com/keys");
    expect(mockOidcFetch).toHaveBeenCalledWith(
      "https://idp.example.com/.well-known/openid-configuration",
    );
  });

  // (b) Issuer mismatch
  it("throws discovery-invalid when doc.issuer !== requested issuer", async () => {
    const issuer = "https://idp.example.com";
    mockOidcFetch.mockResolvedValue(
      makeDiscoveryResponse({
        issuer: "https://other.example.com",
        jwks_uri: "https://other.example.com/keys",
      }),
    );

    await expect(resolveJwksUri(issuer)).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof OidcDiscoveryError && e.code === "discovery-invalid",
    );
  });

  // (c) Missing/empty jwks_uri
  it("throws discovery-invalid when jwks_uri is missing", async () => {
    const issuer = "https://idp.example.com";
    mockOidcFetch.mockResolvedValue(makeDiscoveryResponse({ issuer }));

    await expect(resolveJwksUri(issuer)).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof OidcDiscoveryError && e.code === "discovery-invalid",
    );
  });

  it("throws discovery-invalid when jwks_uri is empty string", async () => {
    const issuer = "https://idp.example.com";
    mockOidcFetch.mockResolvedValue(
      makeDiscoveryResponse({ issuer, jwks_uri: "" }),
    );

    await expect(resolveJwksUri(issuer)).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof OidcDiscoveryError && e.code === "discovery-invalid",
    );
  });

  // (d) Non-https jwks_uri
  it("throws discovery-invalid when jwks_uri is non-https", async () => {
    const issuer = "https://idp.example.com";
    mockOidcFetch.mockResolvedValue(
      makeDiscoveryResponse({
        issuer,
        jwks_uri: "http://idp.example.com/keys",
      }),
    );

    await expect(resolveJwksUri(issuer)).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof OidcDiscoveryError && e.code === "discovery-invalid",
    );
  });

  // (d2) Blocked host in jwks_uri — security R-2/SSRF
  it("throws discovery-invalid when jwks_uri host is blocked (SSRF R-2/d2)", async () => {
    const issuer = "https://idp.example.com";
    // Mock isBlockedHost to return true only for 127.0.0.1
    mockIsBlockedHost.mockImplementation(
      (host: string) => host === "127.0.0.1",
    );
    mockOidcFetch.mockResolvedValue(
      makeDiscoveryResponse({
        issuer,
        jwks_uri: "https://127.0.0.1/keys",
      }),
    );

    await expect(resolveJwksUri(issuer)).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof OidcDiscoveryError && e.code === "discovery-invalid",
    );
  });

  // (e) oidcFetch throws OidcFetchError → discovery-unreachable
  it("throws discovery-unreachable when oidcFetch throws OidcFetchError", async () => {
    const issuer = "https://idp.example.com";
    mockOidcFetch.mockRejectedValue(
      makeOidcFetchError("oidc-fetch-blocked", "blocked host"),
    );

    await expect(resolveJwksUri(issuer)).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof OidcDiscoveryError && e.code === "discovery-unreachable",
    );
  });

  it("throws discovery-unreachable when oidcFetch throws a network error", async () => {
    const issuer = "https://idp.example.com";
    mockOidcFetch.mockRejectedValue(new Error("network error"));

    await expect(resolveJwksUri(issuer)).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof OidcDiscoveryError && e.code === "discovery-unreachable",
    );
  });

  // (f) Discovery URL construction: path-bearing issuer + trailing slash
  it("constructs discovery URL correctly for path-bearing issuer", async () => {
    const issuer = "https://idp.example.com/tenant1";
    mockOidcFetch.mockResolvedValue(
      makeDiscoveryResponse({
        issuer,
        jwks_uri: "https://idp.example.com/tenant1/keys",
      }),
    );

    await resolveJwksUri(issuer);
    expect(mockOidcFetch).toHaveBeenCalledWith(
      "https://idp.example.com/tenant1/.well-known/openid-configuration",
    );
  });

  it("strips trailing slash from issuer before building discovery URL", async () => {
    const issuer = "https://idp.example.com";
    mockOidcFetch.mockResolvedValue(
      makeDiscoveryResponse({
        issuer,
        jwks_uri: "https://idp.example.com/keys",
      }),
    );

    // Pass issuer without trailing slash — URL should not have double-slash
    await resolveJwksUri(issuer);
    expect(mockOidcFetch).toHaveBeenCalledWith(
      "https://idp.example.com/.well-known/openid-configuration",
    );
  });

  // (g) Cache: second call does not invoke oidcFetch again
  it("caches the result and avoids a second oidcFetch call for the same issuer", async () => {
    const issuer = "https://idp.example.com";
    mockOidcFetch.mockResolvedValue(
      makeDiscoveryResponse({
        issuer,
        jwks_uri: "https://idp.example.com/keys",
      }),
    );

    const first = await resolveJwksUri(issuer);
    const second = await resolveJwksUri(issuer);

    expect(first).toBe("https://idp.example.com/keys");
    expect(second).toBe("https://idp.example.com/keys");
    expect(mockOidcFetch).toHaveBeenCalledTimes(1);
  });

  it("fetches again after clearDiscoveryCacheForTesting()", async () => {
    const issuer = "https://idp.example.com";
    // Use mockImplementation so a fresh Response (unconsumed body) is returned
    // for each invocation — a single mockResolvedValue shares the same Response
    // object across calls and the body becomes unreadable after the first .json().
    mockOidcFetch.mockImplementation(() =>
      Promise.resolve(
        makeDiscoveryResponse({
          issuer,
          jwks_uri: "https://idp.example.com/keys",
        }),
      ),
    );

    await resolveJwksUri(issuer);
    clearDiscoveryCacheForTesting();
    await resolveJwksUri(issuer);

    expect(mockOidcFetch).toHaveBeenCalledTimes(2);
  });
});
