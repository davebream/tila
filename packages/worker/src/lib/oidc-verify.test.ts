import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Mock fetch BEFORE importing the module (so it's mocked during module initialization)
const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

// Import AFTER mock is set up
const oidcVerifyModule = await import("./oidc-verify");
const { OidcVerificationError, verifyOidcToken, clearCacheForTesting } =
  oidcVerifyModule;

// Test RSA key pair (generated at test setup)
let testPrivateKey: CryptoKey;
let testPublicKey: CryptoKey;
let testKid: string;

/**
 * Base64URL encode
 */
function base64urlEncode(data: Uint8Array | string): string {
  const str = typeof data === "string" ? data : String.fromCharCode(...data);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Base64URL decode
 */
function base64urlDecode(str: string): Uint8Array {
  const base64 = str.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64);
  return new Uint8Array([...binary].map((c) => c.charCodeAt(0)));
}

/**
 * Sign a test JWT with the test private key
 */
async function signTestJwt(
  payload: Record<string, unknown>,
  header: Record<string, unknown> = {},
): Promise<string> {
  const fullHeader = { alg: "RS256", kid: testKid, ...header };
  const headerB64 = base64urlEncode(JSON.stringify(fullHeader));
  const payloadB64 = base64urlEncode(JSON.stringify(payload));
  const data = `${headerB64}.${payloadB64}`;

  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    testPrivateKey,
    new TextEncoder().encode(data),
  );

  const signatureB64 = base64urlEncode(new Uint8Array(signature));
  return `${data}.${signatureB64}`;
}

/**
 * Export public key to JWK format for mock JWKS
 */
async function exportPublicKeyAsJwk(): Promise<JsonWebKey> {
  return crypto.subtle.exportKey("jwk", testPublicKey);
}

beforeAll(async () => {
  // Generate RSA key pair for tests
  const keyPair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );

  testPrivateKey = keyPair.privateKey;
  testPublicKey = keyPair.publicKey;
  testKid = "test-key-id-1";
});

beforeEach(() => {
  vi.clearAllMocks();
  // Clear the JWKS cache between tests
  clearCacheForTesting();
});

describe("verifyOidcToken", () => {
  const NOW = Math.floor(Date.now() / 1000);
  const VALID_CLAIMS = {
    iss: "https://token.actions.githubusercontent.com",
    aud: "https://tila.example.com",
    sub: "repo:test-org/test-repo:ref:refs/heads/main",
    exp: NOW + 300, // 5 minutes from now
    iat: NOW,
    nbf: NOW,
    jti: "unique-jwt-id-123",
    repository: "test-org/test-repo",
    repository_id: "123456789", // GitHub encodes as string
    repository_owner: "test-org",
    repository_owner_id: "987654321", // GitHub encodes as string
    actor: "test-actor",
    actor_id: "111222333", // GitHub encodes as string
    ref: "refs/heads/main",
    sha: "abc123def456",
    workflow: ".github/workflows/ci.yml",
    run_id: "555666777", // GitHub encodes as string
    run_number: "42", // GitHub encodes as string
    run_attempt: "1", // GitHub encodes as string
    environment: "production",
    event_name: "push",
    repository_visibility: "public",
    job_workflow_ref:
      "test-org/test-repo/.github/workflows/ci.yml@refs/heads/main",
  };

  async function setupMockJwks() {
    const jwk = await exportPublicKeyAsJwk();
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        keys: [{ ...jwk, kid: testKid, alg: "RS256", use: "sig" }],
      }),
    });
  }

  it("accepts a token whose aud is an array containing the expected audience", async () => {
    await setupMockJwks();

    const token = await signTestJwt({
      ...VALID_CLAIMS,
      aud: ["https://other.example.com", "https://tila.example.com"],
    });
    // RFC 7519 allows aud to be a string or an array; the array form must be
    // accepted as long as it contains the expected audience.
    const claims = await verifyOidcToken(token, "https://tila.example.com");
    expect(claims.iss).toBe("https://token.actions.githubusercontent.com");
  });

  it("returns OidcClaims for a valid token", async () => {
    await setupMockJwks();

    const token = await signTestJwt(VALID_CLAIMS);
    const claims = await verifyOidcToken(token, "https://tila.example.com");

    expect(claims).toMatchObject({
      iss: "https://token.actions.githubusercontent.com",
      aud: "https://tila.example.com",
      sub: "repo:test-org/test-repo:ref:refs/heads/main",
      jti: "unique-jwt-id-123",
      repository: "test-org/test-repo",
      repository_id: 123456789, // Coerced to number
      repository_owner: "test-org",
      repository_owner_id: 987654321, // Coerced to number
      actor: "test-actor",
      actor_id: 111222333, // Coerced to number
      ref: "refs/heads/main",
      sha: "abc123def456",
      workflow: ".github/workflows/ci.yml",
      run_id: 555666777, // Coerced to number
      run_number: 42, // Coerced to number
      run_attempt: 1, // Coerced to number
      environment: "production",
      event_name: "push",
      repository_visibility: "public",
      job_workflow_ref:
        "test-org/test-repo/.github/workflows/ci.yml@refs/heads/main",
    });

    expect(mockFetch).toHaveBeenCalledWith(
      "https://token.actions.githubusercontent.com/.well-known/jwks",
    );
  });

  it("throws OIDC_INVALID_TOKEN on malformed JWT (not 3 parts)", async () => {
    await expect(
      verifyOidcToken("not.a.jwt", "https://tila.example.com"),
    ).rejects.toThrow(OidcVerificationError);

    try {
      await verifyOidcToken("not.a.jwt", "https://tila.example.com");
    } catch (err) {
      expect(err).toBeInstanceOf(OidcVerificationError);
      expect((err as InstanceType<typeof OidcVerificationError>).code).toBe(
        "OIDC_INVALID_TOKEN",
      );
    }
  });

  it("throws OIDC_INVALID_TOKEN on non-RS256 algorithm", async () => {
    const token = await signTestJwt(VALID_CLAIMS, { alg: "HS256" });

    await expect(
      verifyOidcToken(token, "https://tila.example.com"),
    ).rejects.toThrow(OidcVerificationError);

    try {
      await verifyOidcToken(token, "https://tila.example.com");
    } catch (err) {
      expect(err).toBeInstanceOf(OidcVerificationError);
      expect((err as InstanceType<typeof OidcVerificationError>).code).toBe(
        "OIDC_INVALID_TOKEN",
      );
    }
  });

  it("throws OIDC_INVALID_ISSUER on wrong issuer", async () => {
    await setupMockJwks();

    const token = await signTestJwt({
      ...VALID_CLAIMS,
      iss: "https://evil.example.com",
    });

    await expect(
      verifyOidcToken(token, "https://tila.example.com"),
    ).rejects.toThrow(OidcVerificationError);

    try {
      await verifyOidcToken(token, "https://tila.example.com");
    } catch (err) {
      expect(err).toBeInstanceOf(OidcVerificationError);
      expect((err as InstanceType<typeof OidcVerificationError>).code).toBe(
        "OIDC_INVALID_ISSUER",
      );
    }
  });

  it("throws OIDC_INVALID_AUDIENCE on wrong audience", async () => {
    await setupMockJwks();

    const token = await signTestJwt(VALID_CLAIMS);

    await expect(
      verifyOidcToken(token, "https://wrong-audience.com"),
    ).rejects.toThrow(OidcVerificationError);

    try {
      await verifyOidcToken(token, "https://wrong-audience.com");
    } catch (err) {
      expect(err).toBeInstanceOf(OidcVerificationError);
      expect((err as InstanceType<typeof OidcVerificationError>).code).toBe(
        "OIDC_INVALID_AUDIENCE",
      );
    }
  });

  it("throws OIDC_TOKEN_EXPIRED on expired token", async () => {
    await setupMockJwks();

    const token = await signTestJwt({
      ...VALID_CLAIMS,
      exp: NOW - 100, // Expired 100 seconds ago
    });

    await expect(
      verifyOidcToken(token, "https://tila.example.com"),
    ).rejects.toThrow(OidcVerificationError);

    try {
      await verifyOidcToken(token, "https://tila.example.com");
    } catch (err) {
      expect(err).toBeInstanceOf(OidcVerificationError);
      expect((err as InstanceType<typeof OidcVerificationError>).code).toBe(
        "OIDC_TOKEN_EXPIRED",
      );
    }
  });

  it("throws OIDC_TOKEN_EXPIRED on future nbf", async () => {
    await setupMockJwks();

    const token = await signTestJwt({
      ...VALID_CLAIMS,
      nbf: NOW + 1000, // Not valid for another 1000 seconds
    });

    await expect(
      verifyOidcToken(token, "https://tila.example.com"),
    ).rejects.toThrow(OidcVerificationError);

    try {
      await verifyOidcToken(token, "https://tila.example.com");
    } catch (err) {
      expect(err).toBeInstanceOf(OidcVerificationError);
      expect((err as InstanceType<typeof OidcVerificationError>).code).toBe(
        "OIDC_TOKEN_EXPIRED",
      );
    }
  });

  it("throws OIDC_SIGNATURE_INVALID on tampered payload", async () => {
    await setupMockJwks();

    const token = await signTestJwt(VALID_CLAIMS);
    // Tamper with the payload by changing the middle part
    const [header, , signature] = token.split(".");
    const tamperedPayload = base64urlEncode(
      JSON.stringify({ ...VALID_CLAIMS, jti: "evil" }),
    );
    const tamperedToken = `${header}.${tamperedPayload}.${signature}`;

    await expect(
      verifyOidcToken(tamperedToken, "https://tila.example.com"),
    ).rejects.toThrow(OidcVerificationError);

    try {
      await verifyOidcToken(tamperedToken, "https://tila.example.com");
    } catch (err) {
      expect(err).toBeInstanceOf(OidcVerificationError);
      expect((err as InstanceType<typeof OidcVerificationError>).code).toBe(
        "OIDC_SIGNATURE_INVALID",
      );
    }
  });

  it("throws OIDC_JWKS_UNAVAILABLE on JWKS fetch failure", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
    });

    const token = await signTestJwt(VALID_CLAIMS);

    await expect(
      verifyOidcToken(token, "https://tila.example.com"),
    ).rejects.toThrow(OidcVerificationError);

    try {
      await verifyOidcToken(token, "https://tila.example.com");
    } catch (err) {
      expect(err).toBeInstanceOf(OidcVerificationError);
      expect((err as InstanceType<typeof OidcVerificationError>).code).toBe(
        "OIDC_JWKS_UNAVAILABLE",
      );
    }
  });

  it("caches JWKS keys and reuses them on second call", async () => {
    await setupMockJwks();

    const token1 = await signTestJwt(VALID_CLAIMS);
    await verifyOidcToken(token1, "https://tila.example.com");

    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Second call should not fetch again (cache hit)
    const token2 = await signTestJwt({ ...VALID_CLAIMS, jti: "different-jti" });
    await verifyOidcToken(token2, "https://tila.example.com");

    expect(mockFetch).toHaveBeenCalledTimes(1); // Still 1, no second fetch
  });

  it("re-fetches JWKS on signature failure (key rotation simulation)", async () => {
    // Generate a second key pair to simulate rotation
    const newKeyPair = await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    );
    const newPrivateKey = newKeyPair.privateKey;
    const newPublicKey = newKeyPair.publicKey;
    const newKid = "test-key-id-2";

    // First call: set up JWKS with original key
    const originalJwk = await exportPublicKeyAsJwk();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        keys: [{ ...originalJwk, kid: testKid, alg: "RS256", use: "sig" }],
      }),
    });

    const token1 = await signTestJwt(VALID_CLAIMS);
    await verifyOidcToken(token1, "https://tila.example.com");

    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Simulate key rotation: sign with new key but JWKS still has old key initially
    const newJwk = await crypto.subtle.exportKey("jwk", newPublicKey);
    const rotatedClaims = { ...VALID_CLAIMS, jti: "rotated-token-id" };
    const headerB64 = base64urlEncode(
      JSON.stringify({ alg: "RS256", kid: newKid }),
    );
    const payloadB64 = base64urlEncode(JSON.stringify(rotatedClaims));
    const data = `${headerB64}.${payloadB64}`;
    const signature = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      newPrivateKey,
      new TextEncoder().encode(data),
    );
    const signatureB64 = base64urlEncode(new Uint8Array(signature));
    const rotatedToken = `${data}.${signatureB64}`;

    // On retry, return new JWKS with the rotated key
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        keys: [{ ...newJwk, kid: newKid, alg: "RS256", use: "sig" }],
      }),
    });

    // Should fail with cached key, re-fetch, and succeed
    const claims = await verifyOidcToken(
      rotatedToken,
      "https://tila.example.com",
    );

    expect(claims.jti).toBe("rotated-token-id");
    expect(mockFetch).toHaveBeenCalledTimes(2); // Original + retry fetch
  });
});
