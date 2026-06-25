/**
 * Table-driven tests for the stateless DPoP proof verifier.
 * Keypair is generated once per describe block using jose — no external fixtures.
 */

import { canonicalizeHtu } from "@tila/schemas";
import {
  type JWK,
  type JWTHeaderParameters,
  SignJWT,
  calculateJwkThumbprint,
  exportJWK,
  generateKeyPair,
} from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type DpopRejectCode,
  SAFE_TO_EXPOSE_CODES,
  verifyDpopProof,
} from "./dpop";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ALG = "ES256";
const HTM = "POST";
const HTU = "https://example.com/api/tasks";
const NOW_MS = 1_700_000_000_000;
const MAX_AGE_MS = 60_000;
const CLOCK_SKEW_MS = 5_000;

let publicKey: CryptoKey;
let privateKey: CryptoKey;
let publicJwk: JWK;
let jkt: string;

async function mintProof(overrides?: {
  htm?: string;
  htu?: string;
  iat?: number;
  jti?: string | null; // pass null to omit
  extraHeaderFields?: Record<string, unknown>;
  privateKeyOverride?: CryptoKey;
}): Promise<string> {
  const iat =
    overrides?.iat !== undefined ? overrides.iat : Math.floor(NOW_MS / 1000);
  const htm = overrides?.htm ?? HTM;
  const htu = overrides?.htu ?? HTU;
  const addJti = overrides?.jti !== undefined ? overrides.jti !== null : true;
  const jti = overrides?.jti ?? crypto.randomUUID();

  const header: JWTHeaderParameters = {
    typ: "dpop+jwt",
    alg: ALG,
    jwk: publicJwk,
    ...(overrides?.extraHeaderFields ?? {}),
  };

  const builder = new SignJWT({
    htm,
    htu,
    iat,
    ...(addJti ? { jti } : {}),
  }).setProtectedHeader(header);

  const pk = overrides?.privateKeyOverride ?? privateKey;
  return builder.sign(pk);
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeAll(async () => {
  const kp = await generateKeyPair(ALG, { extractable: true });
  publicKey = kp.publicKey;
  privateKey = kp.privateKey;
  publicJwk = await exportJWK(publicKey);
  jkt = await calculateJwkThumbprint(publicJwk, "sha256");
});

// ---------------------------------------------------------------------------
// Main test suite
// ---------------------------------------------------------------------------

describe("verifyDpopProof", () => {
  it("valid proof returns { ok: true }", async () => {
    const proof = await mintProof();
    const result = await verifyDpopProof({
      proofJwt: proof,
      expectedJkt: jkt,
      htm: HTM,
      htu: HTU,
      nowMs: NOW_MS,
      maxAgeMs: MAX_AGE_MS,
      clockSkewMs: CLOCK_SKEW_MS,
    });
    expect(result).toEqual({ ok: true });
  });

  it("thumbprint-mismatch when expectedJkt differs from embedded jwk", async () => {
    const proof = await mintProof();
    // Generate a second keypair — its jkt won't match the embedded public key
    const kp2 = await generateKeyPair(ALG, { extractable: true });
    const otherJwk = await exportJWK(kp2.publicKey);
    const otherJkt = await calculateJwkThumbprint(otherJwk, "sha256");
    const result = await verifyDpopProof({
      proofJwt: proof,
      expectedJkt: otherJkt,
      htm: HTM,
      htu: HTU,
      nowMs: NOW_MS,
      maxAgeMs: MAX_AGE_MS,
      clockSkewMs: CLOCK_SKEW_MS,
    });
    expect(result).toEqual({ ok: false, code: "thumbprint-mismatch" });
  });

  it("bad-signature when proof is tampered", async () => {
    const proof = await mintProof();
    // Corrupt the signature (last segment)
    const parts = proof.split(".");
    parts[2] = parts[2].split("").reverse().join("");
    const tampered = parts.join(".");
    const result = await verifyDpopProof({
      proofJwt: tampered,
      expectedJkt: jkt,
      htm: HTM,
      htu: HTU,
      nowMs: NOW_MS,
      maxAgeMs: MAX_AGE_MS,
      clockSkewMs: CLOCK_SKEW_MS,
    });
    expect(result).toEqual({ ok: false, code: "bad-signature" });
  });

  it("htm-mismatch when proof htm does not match", async () => {
    const proof = await mintProof({ htm: "GET" });
    const result = await verifyDpopProof({
      proofJwt: proof,
      expectedJkt: jkt,
      htm: "POST",
      htu: HTU,
      nowMs: NOW_MS,
      maxAgeMs: MAX_AGE_MS,
      clockSkewMs: CLOCK_SKEW_MS,
    });
    expect(result).toEqual({ ok: false, code: "htm-mismatch" });
  });

  it("htm match is case-insensitive", async () => {
    const proof = await mintProof({ htm: "post" });
    const result = await verifyDpopProof({
      proofJwt: proof,
      expectedJkt: jkt,
      htm: "POST",
      htu: HTU,
      nowMs: NOW_MS,
      maxAgeMs: MAX_AGE_MS,
      clockSkewMs: CLOCK_SKEW_MS,
    });
    expect(result).toEqual({ ok: true });
  });

  it("htu-mismatch when proof htu host differs", async () => {
    const proof = await mintProof({
      htu: "https://other.example.com/api/tasks",
    });
    const result = await verifyDpopProof({
      proofJwt: proof,
      expectedJkt: jkt,
      htm: HTM,
      htu: HTU,
      nowMs: NOW_MS,
      maxAgeMs: MAX_AGE_MS,
      clockSkewMs: CLOCK_SKEW_MS,
    });
    expect(result).toEqual({ ok: false, code: "htu-mismatch" });
  });

  it("query-strip equivalence — proof htu with query strip equals server htu without query", async () => {
    // The caller (auth.ts) passes canonicalizeHtu(c.req.url) which already strips query;
    // both sides must produce the same canonical form. This test verifies the verifier
    // compares already-canonical strings.
    const canonicalHtu = canonicalizeHtu(
      "https://example.com/api/tasks?foo=bar",
    );
    const proof = await mintProof({ htu: canonicalHtu });
    const result = await verifyDpopProof({
      proofJwt: proof,
      expectedJkt: jkt,
      htm: HTM,
      htu: HTU, // same as canonicalHtu after stripping
      nowMs: NOW_MS,
      maxAgeMs: MAX_AGE_MS,
      clockSkewMs: CLOCK_SKEW_MS,
    });
    expect(result).toEqual({ ok: true });
  });

  it("stale-proof when iat is older than maxAgeMs", async () => {
    const staleIat = Math.floor((NOW_MS - MAX_AGE_MS - 1000) / 1000);
    const proof = await mintProof({ iat: staleIat });
    const result = await verifyDpopProof({
      proofJwt: proof,
      expectedJkt: jkt,
      htm: HTM,
      htu: HTU,
      nowMs: NOW_MS,
      maxAgeMs: MAX_AGE_MS,
      clockSkewMs: CLOCK_SKEW_MS,
    });
    expect(result).toEqual({ ok: false, code: "stale-proof" });
  });

  it("future-proof when iat is beyond clockSkewMs in the future", async () => {
    const futureIat = Math.floor((NOW_MS + CLOCK_SKEW_MS + 2000) / 1000);
    const proof = await mintProof({ iat: futureIat });
    const result = await verifyDpopProof({
      proofJwt: proof,
      expectedJkt: jkt,
      htm: HTM,
      htu: HTU,
      nowMs: NOW_MS,
      maxAgeMs: MAX_AGE_MS,
      clockSkewMs: CLOCK_SKEW_MS,
    });
    expect(result).toEqual({ ok: false, code: "future-proof" });
  });

  it("accepts iat exactly at the stale boundary (nowMs - maxAgeMs)", async () => {
    const boundaryIat = Math.floor((NOW_MS - MAX_AGE_MS) / 1000);
    const proof = await mintProof({ iat: boundaryIat });
    const result = await verifyDpopProof({
      proofJwt: proof,
      expectedJkt: jkt,
      htm: HTM,
      htu: HTU,
      nowMs: NOW_MS,
      maxAgeMs: MAX_AGE_MS,
      clockSkewMs: CLOCK_SKEW_MS,
    });
    expect(result).toEqual({ ok: true });
  });

  it("non-JWT string (2-segment) returns malformed-proof (never throws)", async () => {
    const result = await verifyDpopProof({
      proofJwt: "header.payload",
      expectedJkt: jkt,
      htm: HTM,
      htu: HTU,
      nowMs: NOW_MS,
      maxAgeMs: MAX_AGE_MS,
      clockSkewMs: CLOCK_SKEW_MS,
    });
    expect(result).toEqual({ ok: false, code: "malformed-proof" });
  });

  it("empty string returns malformed-proof (never throws)", async () => {
    const result = await verifyDpopProof({
      proofJwt: "",
      expectedJkt: jkt,
      htm: HTM,
      htu: HTU,
      nowMs: NOW_MS,
      maxAgeMs: MAX_AGE_MS,
      clockSkewMs: CLOCK_SKEW_MS,
    });
    expect(result).toEqual({ ok: false, code: "malformed-proof" });
  });

  it("garbage string returns malformed-proof (never throws)", async () => {
    const result = await verifyDpopProof({
      proofJwt: "not-a-jwt-at-all!!!",
      expectedJkt: jkt,
      htm: HTM,
      htu: HTU,
      nowMs: NOW_MS,
      maxAgeMs: MAX_AGE_MS,
      clockSkewMs: CLOCK_SKEW_MS,
    });
    expect(result).toEqual({ ok: false, code: "malformed-proof" });
  });

  it("missing jti returns malformed-proof (RFC 9449 §4.2)", async () => {
    const proof = await mintProof({ jti: null });
    const result = await verifyDpopProof({
      proofJwt: proof,
      expectedJkt: jkt,
      htm: HTM,
      htu: HTU,
      nowMs: NOW_MS,
      maxAgeMs: MAX_AGE_MS,
      clockSkewMs: CLOCK_SKEW_MS,
    });
    expect(result).toEqual({ ok: false, code: "malformed-proof" });
  });

  it("empty jti string returns malformed-proof", async () => {
    const proof = await mintProof({ jti: "" });
    const result = await verifyDpopProof({
      proofJwt: proof,
      expectedJkt: jkt,
      htm: HTM,
      htu: HTU,
      nowMs: NOW_MS,
      maxAgeMs: MAX_AGE_MS,
      clockSkewMs: CLOCK_SKEW_MS,
    });
    expect(result).toEqual({ ok: false, code: "malformed-proof" });
  });

  it("jwk containing private 'd' field returns bad-header", async () => {
    const privateJwk = await exportJWK(privateKey);
    // privateJwk includes 'd' (private scalar)
    const proofHeader: JWTHeaderParameters = {
      typ: "dpop+jwt",
      alg: ALG,
      jwk: privateJwk,
    };
    const iat = Math.floor(NOW_MS / 1000);
    const proof = await new SignJWT({
      htm: HTM,
      htu: HTU,
      iat,
      jti: crypto.randomUUID(),
    })
      .setProtectedHeader(proofHeader)
      .sign(privateKey);

    const result = await verifyDpopProof({
      proofJwt: proof,
      expectedJkt: jkt,
      htm: HTM,
      htu: HTU,
      nowMs: NOW_MS,
      maxAgeMs: MAX_AGE_MS,
      clockSkewMs: CLOCK_SKEW_MS,
    });
    expect(result).toEqual({ ok: false, code: "bad-header" });
  });

  it("wrong alg (RS256) in header returns bad-header", async () => {
    // Manually build a JWT with a faked header claiming alg=RS256 but otherwise valid structure.
    // The verifier must reject at the header-check step before attempting signature verification.
    function b64url(s: string): string {
      return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
    }
    const fakeHeader = b64url(
      JSON.stringify({ typ: "dpop+jwt", alg: "RS256", jwk: publicJwk }),
    );
    const realParts = (await mintProof()).split(".");
    // Use the same payload but swap in the faked header; signature won't match but we fail before checking.
    const fakeProof = `${fakeHeader}.${realParts[1]}.${realParts[2]}`;
    const result = await verifyDpopProof({
      proofJwt: fakeProof,
      expectedJkt: jkt,
      htm: HTM,
      htu: HTU,
      nowMs: NOW_MS,
      maxAgeMs: MAX_AGE_MS,
      clockSkewMs: CLOCK_SKEW_MS,
    });
    expect(result).toEqual({ ok: false, code: "bad-header" });
  });

  it("wrong typ in header returns bad-header", async () => {
    function b64url(s: string): string {
      return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
    }
    const fakeHeader = b64url(
      JSON.stringify({ typ: "JWT", alg: "ES256", jwk: publicJwk }),
    );
    const realParts = (await mintProof()).split(".");
    const fakeProof = `${fakeHeader}.${realParts[1]}.${realParts[2]}`;
    const result = await verifyDpopProof({
      proofJwt: fakeProof,
      expectedJkt: jkt,
      htm: HTM,
      htu: HTU,
      nowMs: NOW_MS,
      maxAgeMs: MAX_AGE_MS,
      clockSkewMs: CLOCK_SKEW_MS,
    });
    expect(result).toEqual({ ok: false, code: "bad-header" });
  });

  it("empty expectedJkt still resolves { ok: false } — never throws", async () => {
    const proof = await mintProof();
    const result = await verifyDpopProof({
      proofJwt: proof,
      expectedJkt: "",
      htm: HTM,
      htu: HTU,
      nowMs: NOW_MS,
      maxAgeMs: MAX_AGE_MS,
      clockSkewMs: CLOCK_SKEW_MS,
    });
    expect(result.ok).toBe(false);
  });

  it("garbage expectedJkt still resolves { ok: false } — never throws", async () => {
    const proof = await mintProof();
    const result = await verifyDpopProof({
      proofJwt: proof,
      expectedJkt: "not-a-valid-jkt!!!!",
      htm: HTM,
      htu: HTU,
      nowMs: NOW_MS,
      maxAgeMs: MAX_AGE_MS,
      clockSkewMs: CLOCK_SKEW_MS,
    });
    expect(result.ok).toBe(false);
  });
});

describe("SAFE_TO_EXPOSE_CODES partition", () => {
  it("safe-to-expose codes include clock/url codes", () => {
    const safe = new Set(SAFE_TO_EXPOSE_CODES);
    expect(safe.has("stale-proof")).toBe(true);
    expect(safe.has("future-proof")).toBe(true);
    expect(safe.has("htm-mismatch")).toBe(true);
    expect(safe.has("htu-mismatch")).toBe(true);
  });

  it("key-material codes are NOT in safe-to-expose list", () => {
    const safe = new Set(SAFE_TO_EXPOSE_CODES);
    const keyMaterial: DpopRejectCode[] = [
      "bad-signature",
      "thumbprint-mismatch",
      "malformed-proof",
      "bad-header",
    ];
    for (const code of keyMaterial) {
      expect(safe.has(code)).toBe(false);
    }
  });
});
