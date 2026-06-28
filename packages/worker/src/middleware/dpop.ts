/**
 * Stateless DPoP proof verifier (RFC 9449, no-nonce profile).
 *
 * `verifyDpopProof` is a total function — it NEVER rejects its promise.
 * Every jose call is wrapped in try/catch and mapped to a typed DpopRejectCode.
 *
 * The caller (auth.ts) is responsible for:
 *   - Reading the DPoP header from the request.
 *   - Computing the canonical `htu` via `canonicalizeHtu` from `@tila/schemas`.
 *   - Injecting `nowMs` from `lib/time.ts` (never call Date.now() here).
 *   - Passing `maxAgeMs` = DPOP_PROOF_MAX_AGE_MS and `clockSkewMs` = DPOP_CLOCK_SKEW_MS.
 */

import {
  calculateJwkThumbprint,
  decodeProtectedHeader,
  importJWK,
  jwtVerify,
} from "jose";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Closed union of all reasons a DPoP proof can be rejected.
 *
 * ## Safe-to-expose codes (help a legitimate client fix drift)
 * - `stale-proof`    — proof iat is too far in the past
 * - `future-proof`   — proof iat is too far in the future
 * - `htm-mismatch`   — wrong HTTP method
 * - `htu-mismatch`   — wrong request URL
 *
 * ## Key-material codes (collapse to a generic message externally)
 * - `bad-signature`        — proof signature verification failed
 * - `thumbprint-mismatch`  — embedded jwk thumbprint ≠ expectedJkt
 * - `malformed-proof`      — not a 3-segment JWT / unparseable header or payload
 * - `bad-header`           — typ/alg/jwk header check failed (incl. private key in jwk)
 */
export type DpopRejectCode =
  | "malformed-proof"
  | "bad-header"
  | "thumbprint-mismatch"
  | "bad-signature"
  | "htm-mismatch"
  | "htu-mismatch"
  | "stale-proof"
  | "future-proof";

export type DpopVerifyResult =
  | { ok: true }
  | { ok: false; code: DpopRejectCode };

/**
 * Codes that are safe to surface verbatim in an HTTP response because they
 * help a legitimate client fix clock or URL drift.
 *
 * All other codes (`bad-signature`, `thumbprint-mismatch`, `malformed-proof`,
 * `bad-header`) reveal key-material information and MUST be collapsed to a
 * single generic external message by the caller (Task 7 / auth.ts).
 */
export const SAFE_TO_EXPOSE_CODES: readonly DpopRejectCode[] = [
  "stale-proof",
  "future-proof",
  "htm-mismatch",
  "htu-mismatch",
] as const;

// ---------------------------------------------------------------------------
// Internal typed interfaces (not exported — used to avoid bracket notation)
// ---------------------------------------------------------------------------

interface DpopHeader {
  typ: unknown;
  alg: unknown;
  jwk: unknown;
}

interface EcPublicJwk {
  kty: string;
  crv: string;
  x: string;
  y: string;
  d?: string;
}

interface DpopPayload {
  htm: unknown;
  htu: unknown;
  iat: unknown;
  jti: unknown;
}

// ---------------------------------------------------------------------------
// Verifier
// ---------------------------------------------------------------------------

/**
 * Verify a DPoP proof JWT against the expected bound key thumbprint and request
 * context. Implements the verification steps from RFC 9449 §4.3 (no-nonce
 * stateless profile).
 *
 * The function is total: it resolves, never rejects.
 *
 * @param opts.proofJwt      - Raw value of the `DPoP` request header.
 * @param opts.expectedJkt   - Bound JWK thumbprint (`cnf_jkt` column or `cnf.jkt` claim).
 * @param opts.htm           - Request HTTP method (e.g. "POST").
 * @param opts.htu           - Canonical request URI (no query/fragment) — already
 *                             canonicalized by the caller via `canonicalizeHtu`.
 * @param opts.nowMs         - Current clock in milliseconds (injected — never Date.now()).
 * @param opts.maxAgeMs      - Maximum proof age in ms (`DPOP_PROOF_MAX_AGE_MS`).
 * @param opts.clockSkewMs   - Allowed future-dated iat skew in ms (`DPOP_CLOCK_SKEW_MS`).
 */
export async function verifyDpopProof(opts: {
  proofJwt: string;
  expectedJkt: string;
  htm: string;
  htu: string;
  nowMs: number;
  maxAgeMs: number;
  clockSkewMs: number;
}): Promise<DpopVerifyResult> {
  const { proofJwt, expectedJkt, htm, htu, nowMs, maxAgeMs, clockSkewMs } =
    opts;

  // Step 1: Shape guard — must be exactly 3 base64url segments.
  const parts = proofJwt.split(".");
  if (parts.length !== 3) {
    return { ok: false, code: "malformed-proof" };
  }

  // Step 1b: Decode the protected header.
  let header: DpopHeader;
  try {
    header = (await decodeProtectedHeader(proofJwt)) as DpopHeader;
  } catch {
    return { ok: false, code: "malformed-proof" };
  }

  // Step 2: Header checks — use typed interface so biome allows dot notation.
  if (header.typ !== "dpop+jwt") {
    return { ok: false, code: "bad-header" };
  }
  if (header.alg !== "ES256") {
    return { ok: false, code: "bad-header" };
  }
  const jwkRaw = header.jwk;
  if (!jwkRaw || typeof jwkRaw !== "object" || Array.isArray(jwkRaw)) {
    return { ok: false, code: "bad-header" };
  }
  const jwkObj = jwkRaw as EcPublicJwk;
  // Reject if private key d-parameter is present.
  if (jwkObj.d !== undefined) {
    return { ok: false, code: "bad-header" };
  }
  // Must be a public P-256 EC key.
  if (
    jwkObj.kty !== "EC" ||
    jwkObj.crv !== "P-256" ||
    typeof jwkObj.x !== "string" ||
    typeof jwkObj.y !== "string"
  ) {
    return { ok: false, code: "bad-header" };
  }

  // Step 3: Compute thumbprint and compare with expectedJkt.
  let computedJkt: string;
  try {
    computedJkt = await calculateJwkThumbprint(
      jwkObj as Parameters<typeof calculateJwkThumbprint>[0],
      "sha256",
    );
  } catch {
    return { ok: false, code: "malformed-proof" };
  }
  if (computedJkt !== expectedJkt) {
    return { ok: false, code: "thumbprint-mismatch" };
  }

  // Step 4: Verify signature.
  let payload: DpopPayload;
  try {
    const importedKey = await importJWK(
      jwkObj as Parameters<typeof importJWK>[0],
      "ES256",
    );
    const { payload: verifiedPayload } = await jwtVerify(
      proofJwt,
      importedKey,
      {
        algorithms: ["ES256"],
      },
    );
    payload = verifiedPayload as unknown as DpopPayload;
  } catch {
    return { ok: false, code: "bad-signature" };
  }

  // Step 5: Claim checks.

  // 5a: htm (case-insensitive)
  if (
    typeof payload.htm !== "string" ||
    payload.htm.toUpperCase() !== htm.toUpperCase()
  ) {
    return { ok: false, code: "htm-mismatch" };
  }

  // 5b: htu (exact — both sides already canonical)
  if (typeof payload.htu !== "string" || payload.htu !== htu) {
    return { ok: false, code: "htu-mismatch" };
  }

  // 5c: iat freshness window [nowMs - maxAgeMs, nowMs + clockSkewMs]
  if (typeof payload.iat !== "number") {
    return { ok: false, code: "malformed-proof" };
  }
  const iatMs = payload.iat * 1000;
  if (iatMs < nowMs - maxAgeMs) {
    return { ok: false, code: "stale-proof" };
  }
  if (iatMs > nowMs + clockSkewMs) {
    return { ok: false, code: "future-proof" };
  }

  // 5d: jti presence (RFC 9449 §4.2 requires a unique jti per proof)
  if (typeof payload.jti !== "string" || payload.jti.length === 0) {
    return { ok: false, code: "malformed-proof" };
  }

  return { ok: true };
}
