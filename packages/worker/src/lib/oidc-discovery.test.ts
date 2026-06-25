import { beforeEach, describe, expect, it, vi } from "vitest";

// Keep isBlockedHost + OidcFetchError real; mock only the network egress.
vi.mock("./oidc-fetch", async () => {
  const actual =
    await vi.importActual<typeof import("./oidc-fetch")>("./oidc-fetch");
  return { ...actual, oidcFetch: vi.fn() };
});

import {
  OidcDiscoveryError,
  clearDiscoveryCacheForTesting,
  resolveJwksUri,
} from "./oidc-discovery";
import { OidcFetchError, oidcFetch } from "./oidc-fetch";

const mockedFetch = vi.mocked(oidcFetch);

function discoveryDoc(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const ISSUER = "https://idp.example.com";

beforeEach(() => {
  clearDiscoveryCacheForTesting();
  mockedFetch.mockReset();
});

describe("resolveJwksUri", () => {
  it("returns the jwks_uri from a valid discovery document", async () => {
    mockedFetch.mockResolvedValueOnce(
      discoveryDoc({
        issuer: ISSUER,
        jwks_uri: "https://idp.example.com/keys",
      }),
    );
    await expect(resolveJwksUri(ISSUER)).resolves.toBe(
      "https://idp.example.com/keys",
    );
    expect(mockedFetch).toHaveBeenCalledWith(
      "https://idp.example.com/.well-known/openid-configuration",
    );
  });

  it("constructs the well-known URL for a path-bearing issuer and strips a trailing slash", async () => {
    // The discovery doc echoes the issuer exactly (incl. trailing slash, which
    // OIDC treats as significant); the well-known path strips the slash once.
    mockedFetch.mockResolvedValueOnce(
      discoveryDoc({
        issuer: "https://idp.example.com/tenant1/",
        jwks_uri: "https://idp.example.com/tenant1/keys",
      }),
    );
    await resolveJwksUri("https://idp.example.com/tenant1/");
    expect(mockedFetch).toHaveBeenCalledWith(
      "https://idp.example.com/tenant1/.well-known/openid-configuration",
    );
  });

  it("rejects an issuer mismatch (discovery-invalid)", async () => {
    mockedFetch.mockResolvedValueOnce(
      discoveryDoc({
        issuer: "https://evil.example.com",
        jwks_uri: "https://idp.example.com/keys",
      }),
    );
    await expect(resolveJwksUri(ISSUER)).rejects.toMatchObject({
      code: "discovery-invalid",
    });
  });

  it("rejects a missing jwks_uri (discovery-invalid)", async () => {
    mockedFetch.mockResolvedValueOnce(discoveryDoc({ issuer: ISSUER }));
    await expect(resolveJwksUri(ISSUER)).rejects.toBeInstanceOf(
      OidcDiscoveryError,
    );
  });

  it("rejects a non-https jwks_uri (discovery-invalid)", async () => {
    mockedFetch.mockResolvedValueOnce(
      discoveryDoc({ issuer: ISSUER, jwks_uri: "http://idp.example.com/keys" }),
    );
    await expect(resolveJwksUri(ISSUER)).rejects.toMatchObject({
      code: "discovery-invalid",
    });
  });

  it("rejects a jwks_uri pointing at a blocked host (SSRF, discovery-invalid)", async () => {
    mockedFetch.mockResolvedValueOnce(
      discoveryDoc({ issuer: ISSUER, jwks_uri: "https://127.0.0.1/keys" }),
    );
    await expect(resolveJwksUri(ISSUER)).rejects.toMatchObject({
      code: "discovery-invalid",
    });
  });

  it("maps an OidcFetchError to discovery-unreachable", async () => {
    mockedFetch.mockRejectedValueOnce(
      new OidcFetchError("oidc-fetch-blocked", "blocked"),
    );
    await expect(resolveJwksUri(ISSUER)).rejects.toMatchObject({
      code: "discovery-unreachable",
    });
  });

  it("caches the result — a second call does not re-fetch, cleared by the test helper", async () => {
    mockedFetch.mockResolvedValueOnce(
      discoveryDoc({
        issuer: ISSUER,
        jwks_uri: "https://idp.example.com/keys",
      }),
    );
    await resolveJwksUri(ISSUER);
    await resolveJwksUri(ISSUER);
    expect(mockedFetch).toHaveBeenCalledTimes(1);

    clearDiscoveryCacheForTesting();
    mockedFetch.mockResolvedValueOnce(
      discoveryDoc({
        issuer: ISSUER,
        jwks_uri: "https://idp.example.com/keys",
      }),
    );
    await resolveJwksUri(ISSUER);
    expect(mockedFetch).toHaveBeenCalledTimes(2);
  });
});
