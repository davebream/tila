/**
 * Tests for oidc-verify.ts
 *
 * The test seam is the `./oidc-fetch` module (vi.mock). The verifier must
 * route all JWKS fetches through `oidcFetch`; a bare `globalThis.fetch` call
 * inside the verifier is a regression — caught by the spy-not-called assertion.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock the oidc-fetch module BEFORE importing oidc-verify
// ---------------------------------------------------------------------------

// We declare the mock factory first; the actual mock implementation is
// injected per-test via `mockOidcFetch`.
const mockOidcFetch = vi.fn<(url: string) => Promise<Response>>();

vi.mock("./oidc-fetch", () => ({
  oidcFetch: (url: string, init?: unknown) => mockOidcFetch(url, init as never),
  // Re-export OidcFetchError so it can be thrown from the mock when needed.
  OidcFetchError: class OidcFetchError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(`[${code}] ${message}`);
      this.name = "OidcFetchError";
      this.code = code;
    }
  },
  isBlockedHost: () => false,
}));

// Import AFTER the mock is registered.
const oidcVerifyModule = await import("./oidc-verify");
const {
  OidcVerificationError,
  verifyOidcToken,
  verifyOidcJwt,
  clearCacheForTesting,
} = oidcVerifyModule;

// ---------------------------------------------------------------------------
// Test RSA key pairs
// ---------------------------------------------------------------------------

let testPrivateKey: CryptoKey;
let testPublicKey: CryptoKey;
let testKid: string;

// A second key pair for multi-issuer / rotation tests.
let altPrivateKey: CryptoKey;
let altPublicKey: CryptoKey;
const ALT_KID = "alt-key-id-1";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function base64urlEncode(data: Uint8Array | string): string {
  const str = typeof data === "string" ? data : String.fromCharCode(...data);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecode(str: string): Uint8Array {
  const base64 = str.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64);
  return new Uint8Array([...binary].map((c) => c.charCodeAt(0)));
}

async function signTestJwt(
  payload: Record<string, unknown>,
  header: Record<string, unknown> = {},
  privateKey: CryptoKey = testPrivateKey,
  kid: string = testKid,
): Promise<string> {
  const fullHeader = { alg: "RS256", kid, ...header };
  const headerB64 = base64urlEncode(JSON.stringify(fullHeader));
  const payloadB64 = base64urlEncode(JSON.stringify(payload));
  const data = `${headerB64}.${payloadB64}`;

  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    new TextEncoder().encode(data),
  );

  const signatureB64 = base64urlEncode(new Uint8Array(signature));
  return `${data}.${signatureB64}`;
}

async function exportPublicKeyAsJwk(
  key: CryptoKey = testPublicKey,
): Promise<JsonWebKey> {
  return crypto.subtle.exportKey("jwk", key);
}

/**
 * Build a JWKS JSON string for the given (kid → publicKey) entries.
 * Returns a factory function that creates a fresh Response on every call
 * (Response body can only be consumed once; mockImplementation needs a factory).
 */
async function makeJwksResponseFactory(
  keys: Array<{ kid: string; publicKey: CryptoKey }>,
): Promise<() => Response> {
  const jwks = await Promise.all(
    keys.map(async ({ kid, publicKey }) => {
      const jwk = await crypto.subtle.exportKey("jwk", publicKey);
      return { ...jwk, kid, alg: "RS256", use: "sig" };
    }),
  );
  const body = JSON.stringify({ keys: jwks });
  return () =>
    new Response(body, {
      status: 200,
      headers: { "content-type": "application/json" },
    });
}

/** Convenience: build a single-use Response (for mockResolvedValueOnce). */
async function makeJwksResponse(
  keys: Array<{ kid: string; publicKey: CryptoKey }>,
): Promise<Response> {
  const factory = await makeJwksResponseFactory(keys);
  return factory();
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeAll(async () => {
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

  const altPair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  altPrivateKey = altPair.privateKey;
  altPublicKey = altPair.publicKey;
});

beforeEach(() => {
  vi.clearAllMocks();
  clearCacheForTesting();
});

// ---------------------------------------------------------------------------
// Constants shared across describe blocks
// ---------------------------------------------------------------------------

const GITHUB_ISSUER = "https://token.actions.githubusercontent.com";
const GITHUB_JWKS_URL =
  "https://token.actions.githubusercontent.com/.well-known/jwks";

const NOW = Math.floor(Date.now() / 1000);

const VALID_GITHUB_CLAIMS = {
  iss: GITHUB_ISSUER,
  aud: "https://tila.example.com",
  sub: "repo:test-org/test-repo:ref:refs/heads/main",
  exp: NOW + 300,
  iat: NOW,
  nbf: NOW,
  jti: "unique-jwt-id-123",
  repository: "test-org/test-repo",
  repository_id: "123456789",
  repository_owner: "test-org",
  repository_owner_id: "987654321",
  actor: "test-actor",
  actor_id: "111222333",
  ref: "refs/heads/main",
  sha: "abc123def456",
  workflow: ".github/workflows/ci.yml",
  run_id: "555666777",
  run_number: "42",
  run_attempt: "1",
  environment: "production",
  event_name: "push",
  repository_visibility: "public",
  job_workflow_ref:
    "test-org/test-repo/.github/workflows/ci.yml@refs/heads/main",
};

// ---------------------------------------------------------------------------
// Describe: verifyOidcToken — GitHub path (backward-compat)
// ---------------------------------------------------------------------------

describe("verifyOidcToken (GitHub backward-compat)", () => {
  async function setupMockJwks(
    keys?: Array<{ kid: string; publicKey: CryptoKey }>,
  ) {
    const factory = await makeJwksResponseFactory(
      keys ?? [{ kid: testKid, publicKey: testPublicKey }],
    );
    // Use mockImplementation so each call gets a fresh Response (body can only
    // be consumed once per Response; mockResolvedValue re-uses the same object).
    mockOidcFetch.mockImplementation(() => Promise.resolve(factory()));
  }

  // ----- Integration-seam proof -----

  it("routes JWKS fetch through oidcFetch, never bare globalThis.fetch", async () => {
    await setupMockJwks();

    // Install a spy BEFORE calling verify. A future regression where the
    // verifier calls `fetch(GITHUB_JWKS_URL)` directly must turn this test red.
    const globalFetchSpy = vi.spyOn(globalThis, "fetch");

    const token = await signTestJwt(VALID_GITHUB_CLAIMS);
    await verifyOidcToken(token, "https://tila.example.com");

    expect(globalFetchSpy).not.toHaveBeenCalled();
    expect(mockOidcFetch).toHaveBeenCalledWith(GITHUB_JWKS_URL, undefined);

    globalFetchSpy.mockRestore();
  });

  it("oidcFetch is called with the GitHub JWKS URL (params.jwksUri)", async () => {
    await setupMockJwks();
    const token = await signTestJwt(VALID_GITHUB_CLAIMS);
    await verifyOidcToken(token, "https://tila.example.com");
    expect(mockOidcFetch).toHaveBeenCalledWith(GITHUB_JWKS_URL, undefined);
  });

  // ----- Existing GitHub-path tests (preserved, adapted to new mock seam) -----

  it("accepts a token whose aud is an array containing the expected audience", async () => {
    await setupMockJwks();
    const token = await signTestJwt({
      ...VALID_GITHUB_CLAIMS,
      aud: ["https://other.example.com", "https://tila.example.com"],
    });
    const claims = await verifyOidcToken(token, "https://tila.example.com");
    expect(claims.iss).toBe(GITHUB_ISSUER);
  });

  it("returns OidcClaims with coerced numeric fields for a valid token", async () => {
    await setupMockJwks();
    const token = await signTestJwt(VALID_GITHUB_CLAIMS);
    const claims = await verifyOidcToken(token, "https://tila.example.com");

    expect(claims).toMatchObject({
      iss: GITHUB_ISSUER,
      aud: "https://tila.example.com",
      sub: "repo:test-org/test-repo:ref:refs/heads/main",
      jti: "unique-jwt-id-123",
      repository: "test-org/test-repo",
      repository_id: 123456789,
      repository_owner: "test-org",
      repository_owner_id: 987654321,
      actor: "test-actor",
      actor_id: 111222333,
      ref: "refs/heads/main",
      sha: "abc123def456",
      workflow: ".github/workflows/ci.yml",
      run_id: 555666777,
      run_number: 42,
      run_attempt: 1,
      environment: "production",
      event_name: "push",
      repository_visibility: "public",
      job_workflow_ref:
        "test-org/test-repo/.github/workflows/ci.yml@refs/heads/main",
    });
  });

  it("throws oidc-invalid-token on malformed JWT (not 3 parts)", async () => {
    await expect(
      verifyOidcToken("not.a.jwt", "https://tila.example.com"),
    ).rejects.toThrow(OidcVerificationError);

    try {
      await verifyOidcToken("not.a.jwt", "https://tila.example.com");
    } catch (err) {
      expect(err).toBeInstanceOf(OidcVerificationError);
      expect((err as InstanceType<typeof OidcVerificationError>).code).toBe(
        "oidc-invalid-token",
      );
    }
  });

  it("throws oidc-invalid-token on non-RS256 algorithm", async () => {
    const token = await signTestJwt(VALID_GITHUB_CLAIMS, { alg: "HS256" });
    try {
      await verifyOidcToken(token, "https://tila.example.com");
    } catch (err) {
      expect(err).toBeInstanceOf(OidcVerificationError);
      expect((err as InstanceType<typeof OidcVerificationError>).code).toBe(
        "oidc-invalid-token",
      );
    }
  });

  it("throws oidc-invalid-issuer on wrong issuer", async () => {
    await setupMockJwks();
    const token = await signTestJwt({
      ...VALID_GITHUB_CLAIMS,
      iss: "https://evil.example.com",
    });
    try {
      await verifyOidcToken(token, "https://tila.example.com");
    } catch (err) {
      expect(err).toBeInstanceOf(OidcVerificationError);
      expect((err as InstanceType<typeof OidcVerificationError>).code).toBe(
        "oidc-invalid-issuer",
      );
    }
  });

  it("throws oidc-invalid-audience on wrong audience", async () => {
    await setupMockJwks();
    const token = await signTestJwt(VALID_GITHUB_CLAIMS);
    try {
      await verifyOidcToken(token, "https://wrong-audience.com");
    } catch (err) {
      expect(err).toBeInstanceOf(OidcVerificationError);
      expect((err as InstanceType<typeof OidcVerificationError>).code).toBe(
        "oidc-invalid-audience",
      );
    }
  });

  it("throws oidc-token-expired on expired token", async () => {
    await setupMockJwks();
    const token = await signTestJwt({ ...VALID_GITHUB_CLAIMS, exp: NOW - 100 });
    try {
      await verifyOidcToken(token, "https://tila.example.com");
    } catch (err) {
      expect(err).toBeInstanceOf(OidcVerificationError);
      expect((err as InstanceType<typeof OidcVerificationError>).code).toBe(
        "oidc-token-expired",
      );
    }
  });

  it("throws oidc-token-expired on future nbf", async () => {
    await setupMockJwks();
    const token = await signTestJwt({
      ...VALID_GITHUB_CLAIMS,
      nbf: NOW + 1000,
    });
    try {
      await verifyOidcToken(token, "https://tila.example.com");
    } catch (err) {
      expect(err).toBeInstanceOf(OidcVerificationError);
      expect((err as InstanceType<typeof OidcVerificationError>).code).toBe(
        "oidc-token-expired",
      );
    }
  });

  it("throws oidc-signature-invalid on tampered payload", async () => {
    await setupMockJwks();
    const token = await signTestJwt(VALID_GITHUB_CLAIMS);
    const [header, , signature] = token.split(".");
    const tamperedPayload = base64urlEncode(
      JSON.stringify({ ...VALID_GITHUB_CLAIMS, jti: "evil" }),
    );
    const tamperedToken = `${header}.${tamperedPayload}.${signature}`;
    try {
      await verifyOidcToken(tamperedToken, "https://tila.example.com");
    } catch (err) {
      expect(err).toBeInstanceOf(OidcVerificationError);
      expect((err as InstanceType<typeof OidcVerificationError>).code).toBe(
        "oidc-signature-invalid",
      );
    }
  });

  it("throws oidc-jwks-unavailable on JWKS fetch failure (non-ok response)", async () => {
    mockOidcFetch.mockResolvedValue(new Response("error", { status: 500 }));
    const token = await signTestJwt(VALID_GITHUB_CLAIMS);
    try {
      await verifyOidcToken(token, "https://tila.example.com");
    } catch (err) {
      expect(err).toBeInstanceOf(OidcVerificationError);
      expect((err as InstanceType<typeof OidcVerificationError>).code).toBe(
        "oidc-jwks-unavailable",
      );
    }
  });

  it("maps OidcFetchError thrown by oidcFetch to oidc-jwks-unavailable", async () => {
    // Import the mocked OidcFetchError class from the mock module.
    const { OidcFetchError: MockOidcFetchError } = await import("./oidc-fetch");
    mockOidcFetch.mockRejectedValue(
      new MockOidcFetchError("oidc-fetch-blocked", "blocked host"),
    );
    const token = await signTestJwt(VALID_GITHUB_CLAIMS);
    try {
      await verifyOidcToken(token, "https://tila.example.com");
    } catch (err) {
      expect(err).toBeInstanceOf(OidcVerificationError);
      expect((err as InstanceType<typeof OidcVerificationError>).code).toBe(
        "oidc-jwks-unavailable",
      );
    }
  });

  it("caches JWKS keys and reuses them on second call", async () => {
    await setupMockJwks();
    const token1 = await signTestJwt(VALID_GITHUB_CLAIMS);
    await verifyOidcToken(token1, "https://tila.example.com");
    expect(mockOidcFetch).toHaveBeenCalledTimes(1);

    const token2 = await signTestJwt({
      ...VALID_GITHUB_CLAIMS,
      jti: "different-jti",
    });
    await verifyOidcToken(token2, "https://tila.example.com");
    expect(mockOidcFetch).toHaveBeenCalledTimes(1); // still 1, no second fetch
  });

  it("re-fetches JWKS on signature failure — key rotation (oidcFetch called twice)", async () => {
    // Sign token1 with testPrivateKey → cache the testPublicKey.
    const res1 = await makeJwksResponse([
      { kid: testKid, publicKey: testPublicKey },
    ]);
    mockOidcFetch.mockResolvedValueOnce(res1);

    const token1 = await signTestJwt(VALID_GITHUB_CLAIMS);
    await verifyOidcToken(token1, "https://tila.example.com");
    expect(mockOidcFetch).toHaveBeenCalledTimes(1);

    // Now sign with altPrivateKey (different kid=ALT_KID).
    const rotatedClaims = { ...VALID_GITHUB_CLAIMS, jti: "rotated-token-id" };
    const rotatedToken = await signTestJwt(
      rotatedClaims,
      {},
      altPrivateKey,
      ALT_KID,
    );

    // On rotation retry, return JWKS containing altPublicKey.
    const res2 = await makeJwksResponse([
      { kid: ALT_KID, publicKey: altPublicKey },
    ]);
    mockOidcFetch.mockResolvedValueOnce(res2);

    const claims = await verifyOidcToken(
      rotatedToken,
      "https://tila.example.com",
    );
    expect(claims.jti).toBe("rotated-token-id");
    expect(mockOidcFetch).toHaveBeenCalledTimes(2); // original + retry
  });
});

// ---------------------------------------------------------------------------
// Describe: verifyOidcJwt — generic issuer-parameterized core (Task 3)
// ---------------------------------------------------------------------------

describe("verifyOidcJwt (generic core)", () => {
  const CUSTOM_ISSUER = "https://oidc.example.com";
  const CUSTOM_JWKS_URL = "https://oidc.example.com/.well-known/jwks.json";
  const CUSTOM_AUDIENCE = "https://app.example.com";

  const VALID_CUSTOM_CLAIMS = {
    iss: CUSTOM_ISSUER,
    aud: CUSTOM_AUDIENCE,
    sub: "user:alice",
    exp: NOW + 300,
    iat: NOW,
    nbf: NOW,
    jti: "custom-jti-1",
  };

  async function setupCustomJwks(
    keys: Array<{ kid: string; publicKey: CryptoKey }> = [
      { kid: testKid, publicKey: testPublicKey },
    ],
  ) {
    const factory = await makeJwksResponseFactory(keys);
    mockOidcFetch.mockImplementation(() => Promise.resolve(factory()));
  }

  it("verifies a non-GitHub issuer and returns raw {header, payload}", async () => {
    await setupCustomJwks();
    const token = await signTestJwt(VALID_CUSTOM_CLAIMS);

    const result = await verifyOidcJwt(token, {
      issuer: CUSTOM_ISSUER,
      audience: CUSTOM_AUDIENCE,
      jwksUri: CUSTOM_JWKS_URL,
    });

    expect(result).toHaveProperty("header");
    expect(result).toHaveProperty("payload");
    expect(result.payload.iss).toBe(CUSTOM_ISSUER);
    expect(result.payload.sub).toBe("user:alice");
    // Raw payload — numeric fields not coerced.
    expect(result.payload.exp).toBe(VALID_CUSTOM_CLAIMS.exp);
  });

  it("oidcFetch is called with params.jwksUri, never a payload.iss-derived URL", async () => {
    await setupCustomJwks();
    const token = await signTestJwt(VALID_CUSTOM_CLAIMS);

    await verifyOidcJwt(token, {
      issuer: CUSTOM_ISSUER,
      audience: CUSTOM_AUDIENCE,
      jwksUri: CUSTOM_JWKS_URL,
    });

    expect(mockOidcFetch).toHaveBeenCalledWith(CUSTOM_JWKS_URL, undefined);
    // Ensure it was NOT called with a URL derived from payload.iss
    for (const call of mockOidcFetch.mock.calls) {
      expect(call[0]).not.toContain("oidc.example.com/.well-known/openid");
    }
  });

  it("cache isolation: two issuers with same kid use their own keys", async () => {
    // Issuer A uses testPublicKey with testKid.
    // Issuer B uses altPublicKey with the SAME testKid.
    const ISSUER_A = "https://issuer-a.example.com";
    const ISSUER_B = "https://issuer-b.example.com";
    const JWKS_A = "https://issuer-a.example.com/.well-known/jwks.json";
    const JWKS_B = "https://issuer-b.example.com/.well-known/jwks.json";

    const resA = await makeJwksResponse([
      { kid: testKid, publicKey: testPublicKey },
    ]);
    const resB = await makeJwksResponse([
      { kid: testKid, publicKey: altPublicKey },
    ]);

    mockOidcFetch
      .mockResolvedValueOnce(resA) // first call → JWKS for A
      .mockResolvedValueOnce(resB); // second call → JWKS for B

    const tokenA = await signTestJwt(
      {
        iss: ISSUER_A,
        aud: "aud-a",
        sub: "a",
        exp: NOW + 300,
        iat: NOW,
        nbf: NOW,
        jti: "a1",
      },
      {},
      testPrivateKey,
      testKid,
    );
    const tokenB = await signTestJwt(
      {
        iss: ISSUER_B,
        aud: "aud-b",
        sub: "b",
        exp: NOW + 300,
        iat: NOW,
        nbf: NOW,
        jti: "b1",
      },
      {},
      altPrivateKey,
      testKid, // same kid, but different issuer
    );

    const resultA = await verifyOidcJwt(tokenA, {
      issuer: ISSUER_A,
      audience: "aud-a",
      jwksUri: JWKS_A,
    });
    const resultB = await verifyOidcJwt(tokenB, {
      issuer: ISSUER_B,
      audience: "aud-b",
      jwksUri: JWKS_B,
    });

    // Both should succeed with their own keys — no cross-issuer shadow.
    expect(resultA.payload.iss).toBe(ISSUER_A);
    expect(resultB.payload.iss).toBe(ISSUER_B);
  });

  it("throws oidc-invalid-issuer when payload.iss !== params.issuer", async () => {
    await setupCustomJwks();
    const token = await signTestJwt({
      ...VALID_CUSTOM_CLAIMS,
      iss: "https://attacker.example.com",
    });

    await expect(
      verifyOidcJwt(token, {
        issuer: CUSTOM_ISSUER,
        audience: CUSTOM_AUDIENCE,
        jwksUri: CUSTOM_JWKS_URL,
      }),
    ).rejects.toMatchObject({ code: "oidc-invalid-issuer" });
  });

  it("rotation retry: oidcFetch called twice on signature failure with cached keys", async () => {
    // First request: cache testPublicKey for CUSTOM_ISSUER.
    const res1 = await makeJwksResponse([
      { kid: testKid, publicKey: testPublicKey },
    ]);
    mockOidcFetch.mockResolvedValueOnce(res1);

    const token1 = await signTestJwt(VALID_CUSTOM_CLAIMS);
    await verifyOidcJwt(token1, {
      issuer: CUSTOM_ISSUER,
      audience: CUSTOM_AUDIENCE,
      jwksUri: CUSTOM_JWKS_URL,
    });
    expect(mockOidcFetch).toHaveBeenCalledTimes(1);

    // Sign with altPrivateKey (ALT_KID not yet in cache).
    const rotatedToken = await signTestJwt(
      { ...VALID_CUSTOM_CLAIMS, jti: "rotated-2" },
      {},
      altPrivateKey,
      ALT_KID,
    );

    // On rotation retry, return JWKS with altPublicKey.
    const res2 = await makeJwksResponse([
      { kid: ALT_KID, publicKey: altPublicKey },
    ]);
    mockOidcFetch.mockResolvedValueOnce(res2);

    const result = await verifyOidcJwt(rotatedToken, {
      issuer: CUSTOM_ISSUER,
      audience: CUSTOM_AUDIENCE,
      jwksUri: CUSTOM_JWKS_URL,
    });
    expect(result.payload.jti).toBe("rotated-2");
    expect(mockOidcFetch).toHaveBeenCalledTimes(2);
  });

  it("strict aud: array membership accepted", async () => {
    await setupCustomJwks();
    const token = await signTestJwt({
      ...VALID_CUSTOM_CLAIMS,
      aud: [CUSTOM_AUDIENCE, "https://other.example.com"],
    });
    const result = await verifyOidcJwt(token, {
      issuer: CUSTOM_ISSUER,
      audience: CUSTOM_AUDIENCE,
      jwksUri: CUSTOM_JWKS_URL,
    });
    expect(result.payload.iss).toBe(CUSTOM_ISSUER);
  });

  it("strict aud: absent aud is rejected explicitly (not via incidental falsy path)", async () => {
    await setupCustomJwks();
    // Build claims without the aud field by omitting it at construction time.
    const { aud: _aud, ...claimsWithoutAudBase } = VALID_CUSTOM_CLAIMS;
    const claimsWithoutAud: Record<string, unknown> = {
      ...claimsWithoutAudBase,
    };
    const token = await signTestJwt(claimsWithoutAud);

    await expect(
      verifyOidcJwt(token, {
        issuer: CUSTOM_ISSUER,
        audience: CUSTOM_AUDIENCE,
        jwksUri: CUSTOM_JWKS_URL,
      }),
    ).rejects.toMatchObject({ code: "oidc-invalid-audience" });
  });

  it("jku/x5u header ignored — oidcFetch never called with the jku value", async () => {
    // A token carrying a jku header that points to an attacker-controlled URL.
    // The verifier must use params.jwksUri exclusively.
    const attackerJkuUrl = "https://attacker.example.com/jwks.json";
    await setupCustomJwks();

    const token = await signTestJwt(VALID_CUSTOM_CLAIMS, {
      jku: attackerJkuUrl,
      x5u: "https://attacker.example.com/x5u",
    });

    await verifyOidcJwt(token, {
      issuer: CUSTOM_ISSUER,
      audience: CUSTOM_AUDIENCE,
      jwksUri: CUSTOM_JWKS_URL,
    });

    // oidcFetch must only ever be called with the trusted jwksUri.
    for (const call of mockOidcFetch.mock.calls) {
      expect(call[0]).not.toBe(attackerJkuUrl);
      expect(call[0]).not.toContain("attacker.example.com");
    }
    // Confirm it was called with the correct URL.
    expect(mockOidcFetch).toHaveBeenCalledWith(CUSTOM_JWKS_URL, undefined);
  });
});

// ---------------------------------------------------------------------------
// Describe: Task 4 — forgery + issuer-confusion regression tests
// ---------------------------------------------------------------------------

describe("verifyOidcJwt — forgery and issuer-confusion regressions", () => {
  const ISSUER_A = "https://issuer-a.example.com";
  const ISSUER_B = "https://issuer-b.example.com";
  const JWKS_A = "https://issuer-a.example.com/.well-known/jwks.json";
  const JWKS_B = "https://issuer-b.example.com/.well-known/jwks.json";

  it("cache-key forgery: kid with colons/newlines can't shadow another issuer's key", async () => {
    // Prime issuer A's cache with testPublicKey under testKid.
    const resA = await makeJwksResponse([
      { kid: testKid, publicKey: testPublicKey },
    ]);
    mockOidcFetch.mockResolvedValueOnce(resA);

    const tokenA = await signTestJwt(
      {
        iss: ISSUER_A,
        aud: "aud-a",
        sub: "a",
        exp: NOW + 300,
        iat: NOW,
        nbf: NOW,
        jti: "a1",
      },
      {},
      testPrivateKey,
      testKid,
    );
    await verifyOidcJwt(tokenA, {
      issuer: ISSUER_A,
      audience: "aud-a",
      jwksUri: JWKS_A,
    });

    // Now craft a token for issuer B whose kid is constructed to look like
    // issuer A's cache key: `${ISSUER_A.length}:${ISSUER_A}:${testKid}`.
    // With a length-prefixed cache key this cannot collide.
    const forgeryKid = `${ISSUER_A.length}:${ISSUER_A}:${testKid}`;

    // issuer B's JWKS: return altPublicKey under the forgery kid.
    const resB = await makeJwksResponse([
      { kid: forgeryKid, publicKey: altPublicKey },
    ]);
    mockOidcFetch.mockResolvedValueOnce(resB);

    // Sign with testPrivateKey (issuer A's key) but claim iss = ISSUER_B.
    // If the cache key wasn't length-prefixed, the forged kid could resolve to
    // issuer A's CryptoKey. With proper isolation it must NOT.
    // The token will fail — either wrong issuer assertion or signature failure.
    const forgeryToken = await signTestJwt(
      {
        iss: ISSUER_B,
        aud: "aud-b",
        sub: "b",
        exp: NOW + 300,
        iat: NOW,
        nbf: NOW,
        jti: "b1",
      },
      {},
      testPrivateKey, // attacker signs with A's key but claims B's issuer
      forgeryKid,
    );

    // Expect verification to fail — issuer B must NOT accept issuer A's key.
    // Either oidc-invalid-issuer (if iss check fires before key lookup) or
    // oidc-signature-invalid (if key lookup fails to get the right key).
    await expect(
      verifyOidcJwt(forgeryToken, {
        issuer: ISSUER_B,
        audience: "aud-b",
        jwksUri: JWKS_B,
      }),
    ).rejects.toBeInstanceOf(OidcVerificationError);
  });

  it("issuer confusion: a token claiming a different iss is rejected, no fetch to payload.iss URL", async () => {
    // The verifier must assert payload.iss === params.issuer before any network
    // call that might be influenced by payload.iss.
    const ATTACKER_ISS = "https://attacker.example.com";

    // Set up mock for the legitimate JWKS url (to handle any fetch that happens).
    const factory = await makeJwksResponseFactory([
      { kid: testKid, publicKey: testPublicKey },
    ]);
    mockOidcFetch.mockImplementation(() => Promise.resolve(factory()));

    const token = await signTestJwt({
      iss: ATTACKER_ISS,
      aud: "aud-a",
      sub: "attacker",
      exp: NOW + 300,
      iat: NOW,
      nbf: NOW,
      jti: "evil",
    });

    await expect(
      verifyOidcJwt(token, {
        issuer: ISSUER_A,
        audience: "aud-a",
        jwksUri: JWKS_A,
      }),
    ).rejects.toMatchObject({ code: "oidc-invalid-issuer" });

    // Confirm oidcFetch was never called with an attacker-derived URL.
    for (const call of mockOidcFetch.mock.calls) {
      expect(call[0]).not.toContain("attacker.example.com");
    }
  });
});

// ---------------------------------------------------------------------------
// Describe: verifyOidcToken backward-compat — numeric coercion
// ---------------------------------------------------------------------------

describe("verifyOidcToken (backward-compat coercion)", () => {
  it("returns coerced numeric OidcClaims from verifyOidcToken wrapper", async () => {
    const res = await makeJwksResponse([
      { kid: testKid, publicKey: testPublicKey },
    ]);
    mockOidcFetch.mockResolvedValue(res);

    const token = await signTestJwt(VALID_GITHUB_CLAIMS);
    const claims = await verifyOidcToken(token, "https://tila.example.com");

    // Coercion: string "123456789" → number 123456789.
    expect(typeof claims.repository_id).toBe("number");
    expect(claims.repository_id).toBe(123456789);
    expect(typeof claims.actor_id).toBe("number");
    expect(claims.actor_id).toBe(111222333);
    expect(typeof claims.run_id).toBe("number");
    expect(claims.run_id).toBe(555666777);
    expect(typeof claims.run_number).toBe("number");
    expect(claims.run_number).toBe(42);
    expect(typeof claims.run_attempt).toBe("number");
    expect(claims.run_attempt).toBe(1);
  });
});
